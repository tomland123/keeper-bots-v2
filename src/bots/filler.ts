import {
	NewUserRecord,
	OrderRecord,
	ClearingHouseUser,
	ReferrerInfo,
	isOracleValid,
	ClearingHouse,
	MarketAccount,
	SlotSubscriber,
	calculateAskPrice,
	calculateBidPrice,
	MakerInfo,
	isFillableByVAMM,
} from '@drift-labs/sdk';
import { promiseTimeout } from '@drift-labs/sdk/lib/util/promiseTimeout';
import { Mutex, tryAcquire, withTimeout, E_ALREADY_LOCKED } from 'async-mutex';

import {
	SendTransactionError,
	Transaction,
	TransactionResponse,
	TransactionSignature,
	TransactionInstruction,
	ComputeBudgetProgram,
} from '@solana/web3.js';

import { getErrorCode, getErrorMessage } from '../error';
import { logger } from '../logger';
import { DLOB, NodeToFill } from '../dlob/DLOB';
import { UserMap } from '../userMap';
import { UserStatsMap } from '../userStatsMap';
import { Bot } from '../types';
import { Metrics } from '../metrics';

const FILL_ORDER_BACKOFF = 0; //5000;
const dlobMutexError = new Error('dlobMutex timeout');

export class FillerBot implements Bot {
	public readonly name: string;
	public readonly dryRun: boolean;
	public readonly defaultIntervalMs: number = 1000;

	private clearingHouse: ClearingHouse;
	private slotSubscriber: SlotSubscriber;

	private dlobMutex = withTimeout(
		new Mutex(),
		10 * this.defaultIntervalMs,
		dlobMutexError
	);
	private dlob: DLOB;

	private userMap: UserMap;
	private userStatsMap: UserStatsMap;

	private periodicTaskMutex = new Mutex();

	private intervalIds: Array<NodeJS.Timer> = [];
	private metrics: Metrics | undefined;
	private throttledNodes = new Map<string, number>();

	constructor(
		name: string,
		dryRun: boolean,
		clearingHouse: ClearingHouse,
		slotSubscriber: SlotSubscriber,
		metrics?: Metrics | undefined
	) {
		this.name = name;
		this.dryRun = dryRun;
		this.clearingHouse = clearingHouse;
		this.slotSubscriber = slotSubscriber;
		this.metrics = metrics;
	}

	public async init() {
		logger.warn('filler initing');

		const initPromises: Array<Promise<any>> = [];

		this.userMap = new UserMap(
			this.clearingHouse,
			this.clearingHouse.userAccountSubscriptionConfig
		);
		this.metrics?.trackObjectSize('filler-userMap', this.userMap);
		initPromises.push(this.userMap.fetchAllUsers());

		this.userStatsMap = new UserStatsMap(
			this.clearingHouse,
			this.clearingHouse.userAccountSubscriptionConfig
		);
		this.metrics?.trackObjectSize('filler-userStatsMap', this.userStatsMap);
		initPromises.push(this.userStatsMap.fetchAllUserStats());

		await Promise.all(initPromises);

		logger.warn('init done');
	}

	public async reset() {}

	public async startIntervalLoop(intervalMs: number) {
		// await this.tryFill();
		const intervalId = setInterval(this.tryFill.bind(this), intervalMs);
		this.intervalIds.push(intervalId);

		logger.info(`${this.name} Bot started!`);
	}

	public async trigger(record: any) {
		if (record.eventType === 'OrderRecord') {
			await this.userMap.updateWithOrder(record as OrderRecord);
			await this.userStatsMap.updateWithOrder(
				record as OrderRecord,
				this.userMap
			);
			await this.tryFill();
		} else if (record.eventType === 'NewUserRecord') {
			await this.userMap.mustGet(
				(record as NewUserRecord).userAuthority.toString()
			);
			await this.userStatsMap.mustGet(
				(record as NewUserRecord).userAuthority.toString()
			);
		}
	}

	public viewDlob(): DLOB {
		return this.dlob;
	}

	private async getFillableNodesForMarket(
		market: MarketAccount
	): Promise<Array<NodeToFill>> {
		const marketIndex = market.marketIndex;
		const oraclePriceData =
			this.clearingHouse.getOracleDataForMarket(marketIndex);
		const oracleIsValid = isOracleValid(
			market.amm,
			oraclePriceData,
			this.clearingHouse.getStateAccount().oracleGuardRails,
			this.slotSubscriber.getSlot()
		);

		const vAsk = calculateAskPrice(market, oraclePriceData);
		const vBid = calculateBidPrice(market, oraclePriceData);

		let nodes: Array<NodeToFill> = [];
		await this.dlobMutex.runExclusive(async () => {
			nodes = this.dlob.findNodesToFill(
				marketIndex,
				vBid,
				vAsk,
				this.slotSubscriber.getSlot(),
				oracleIsValid ? oraclePriceData : undefined
			);
		});

		return nodes;
	}

	private getNodeToFillSignature(node: NodeToFill): string {
		if (!node.node.userAccount) {
			return '~';
		}
		return `${node.node.userAccount.toString()}-${node.node.order.orderId.toString()}`;
	}

	private filterFillableNodes(nodeToFill: NodeToFill): boolean {
		if (nodeToFill.node.isVammNode()) {
			return false;
		}

		if (nodeToFill.node.haveFilled) {
			return false;
		}

		if (this.throttledNodes.has(this.getNodeToFillSignature(nodeToFill))) {
			const lastFillAttempt = this.throttledNodes.get(
				this.getNodeToFillSignature(nodeToFill)
			);
			if (lastFillAttempt + FILL_ORDER_BACKOFF > Date.now()) {
				return false;
			} else {
				this.throttledNodes.delete(this.getNodeToFillSignature(nodeToFill));
			}
		}

		const marketIndex = nodeToFill.node.market.marketIndex;
		const oraclePriceData =
			this.clearingHouse.getOracleDataForMarket(marketIndex);

		if (
			!nodeToFill.makerNode &&
			!isFillableByVAMM(
				nodeToFill.node.order,
				nodeToFill.node.market,
				oraclePriceData,
				this.slotSubscriber.getSlot(),
				this.clearingHouse.getStateAccount().maxAuctionDuration
			)
		) {
			return false;
		}

		return true;
	}

	private async getNodeFillInfo(nodeToFill: NodeToFill): Promise<{
		makerInfo: MakerInfo | undefined;
		chUser: ClearingHouseUser;
		referrerInfo: ReferrerInfo;
	}> {
		let makerInfo: MakerInfo | undefined;
		if (nodeToFill.makerNode) {
			const makerAuthority = (
				await this.userMap.mustGet(nodeToFill.makerNode.userAccount.toString())
			).getUserAccount().authority;
			const makerUserStats = (
				await this.userStatsMap.mustGet(makerAuthority.toString())
			).userStatsAccountPublicKey;
			makerInfo = {
				maker: nodeToFill.makerNode.userAccount,
				order: nodeToFill.makerNode.order,
				makerStats: makerUserStats,
			};
		}

		const chUser = await this.userMap.mustGet(
			nodeToFill.node.userAccount.toString()
		);
		const referrerInfo = (
			await this.userStatsMap.mustGet(
				chUser.getUserAccount().authority.toString()
			)
		).getReferrerInfo();
		return Promise.resolve({
			makerInfo,
			chUser,
			referrerInfo,
		});
	}

	private async tryFillNode(
		nodeToFill: NodeToFill
	): Promise<TransactionSignature> {
		if (!nodeToFill) {
			logger.error(`${this.name} nodeToFill is null`);
			return;
		}

		const marketIndex = nodeToFill.node.market.marketIndex;

		logger.info(
			`${
				this.name
			} trying to fill (account: ${nodeToFill.node.userAccount.toString()}) order ${nodeToFill.node.order.orderId.toString()} on mktIdx: ${marketIndex.toString()}`
		);

		const { makerInfo, chUser, referrerInfo } = await this.getNodeFillInfo(
			nodeToFill
		);

		if (this.dryRun) {
			logger.info(`${this.name} dry run, not filling`);
			return;
		}

		let txSig: null | TransactionSignature;
		const reqStart = Date.now();
		try {
			this.metrics?.recordRpcRequests('fillOrder', this.name);
			txSig = await this.clearingHouse.fillOrder(
				nodeToFill.node.userAccount,
				chUser.getUserAccount(),
				nodeToFill.node.order,
				makerInfo,
				referrerInfo
			);
			this.metrics?.recordFilledOrder(
				this.clearingHouse.provider.wallet.publicKey,
				this.name
			);
			logger.info(
				`${
					this.name
				} Filled user (account: ${nodeToFill.node.userAccount.toString()}) order: ${nodeToFill.node.order.orderId.toString()}, Tx: ${txSig}`
			);
		} catch (error) {
			nodeToFill.node.haveFilled = false;
			this.throttledNodes.set(
				this.getNodeToFillSignature(nodeToFill),
				Date.now()
			);

			const errorCode = getErrorCode(error);
			this.metrics?.recordErrorCode(
				errorCode,
				this.clearingHouse.provider.wallet.publicKey,
				this.name
			);

			const errorMessage = getErrorMessage(error as SendTransactionError);

			if (errorMessage === 'OrderDoesNotExist') {
				await this.dlobMutex.runExclusive(async () => {
					this.dlob.remove(
						nodeToFill.node.order,
						nodeToFill.node.userAccount,
						() => {
							logger.error(
								`Order ${nodeToFill.node.order.orderId.toString()} not found when trying to fill. Removing from order list`
							);
						}
					);
				});
			}
			logger.error(
				`Error (${errorCode}) filling user (account: ${nodeToFill.node.userAccount.toString()}) order: ${nodeToFill.node.order.orderId.toString()}, mktIdx: ${marketIndex.toNumber()}`
			);
		} finally {
			const duration = Date.now() - reqStart;
			this.metrics?.recordRpcDuration(
				this.clearingHouse.connection.rpcEndpoint,
				'fillOrder',
				duration,
				false,
				this.name
			);
		}

		return txSig;
	}

	/**
	 * Returns the number of bytes occupied by this array if it were serialized in compact-u16-format.
	 * NOTE: assumes each element of the array is 1 byte (not sure if this holds?)
	 *
	 * https://docs.solana.com/developing/programming-model/transactions#compact-u16-format
	 *
	 * https://stackoverflow.com/a/69951832
	 *  hex     |  compact-u16
	 *  --------+------------
	 *  0x0000  |  [0x00]
	 *  0x0001  |  [0x01]
	 *  0x007f  |  [0x7f]
	 *  0x0080  |  [0x80 0x01]
	 *  0x3fff  |  [0xff 0x7f]
	 *  0x4000  |  [0x80 0x80 0x01]
	 *  0xc000  |  [0x80 0x80 0x03]
	 *  0xffff  |  [0xff 0xff 0x03])
	 */
	private calcCompactU16EncodedSize(array: any[], elemSize = 1): number {
		if (array.length > 0x3fff) {
			return 3 + array.length * elemSize;
		} else if (array.length > 0x7f) {
			return 2 + array.length * elemSize;
		} else {
			return 1 + (array.length * elemSize || 1);
		}
	}

	/**
	 * Instruction are made of 3 parts:
	 * - index of accounts where programId resides (1 byte)
	 * - affected accounts    (compact-u16-format byte array)
	 * - raw instruction data (compact-u16-format byte array)
	 * @param ix The instruction to calculate size for.
	 */
	private calcIxEncodedSize(ix: TransactionInstruction): number {
		return (
			1 +
			this.calcCompactU16EncodedSize(new Array(ix.keys.length), 1) +
			this.calcCompactU16EncodedSize(new Array(ix.data.byteLength), 1)
		);
	}

	private async sleep(ms: number) {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}

	private isLogFillOrder(log: string): boolean {
		return log === 'Program log: Instruction: FillOrder';
	}

	private async processBulkFillTxLogs(
		nodesFilled: Array<NodeToFill>,
		txSig: TransactionSignature
	) {
		let tx: TransactionResponse | null = null;
		let attempts = 0;
		while (tx === null && attempts < 10) {
			logger.info(`waiting for ${txSig} to be confirmed`);
			tx = await this.clearingHouse.connection.getTransaction(txSig, {
				commitment: 'confirmed',
			});
			attempts++;
			await this.sleep(1000);
		}

		if (tx === null) {
			logger.error(`tx ${txSig} not found`);
			return;
		}

		let nextIsFillRecord = false;
		let ixIdx = -1; // skip ComputeBudgetProgram
		let successCount = 0;
		for (const log of tx.meta.logMessages) {
			if (log === null) {
				logger.error(`null log message on tx: ${txSig}`);
				continue;
			}

			if (nextIsFillRecord) {
				if (log.includes('Order does not exist')) {
					const filledNode = nodesFilled[ixIdx];
					logger.error(` ${log}, ix: ${ixIdx}`);
					logger.error(
						`   assoc order: ${filledNode.node.userAccount.toString()}, ${filledNode.node.order.orderId.toNumber()}`
					);
					await this.dlobMutex.runExclusive(async () => {
						this.dlob.remove(
							filledNode.node.order,
							filledNode.node.userAccount,
							() => {
								logger.error(
									`Order ${filledNode.node.order.orderId.toString()} not found when trying to fill. Removing from order list`
								);
							}
						);
					});
				} else if (log.includes('Amm cant fulfill order')) {
					const filledNode = nodesFilled[ixIdx];
					logger.error(` ${log}, ix: ${ixIdx}`);
					logger.error(
						`  assoc order: ${filledNode.node.userAccount.toString()}, ${filledNode.node.order.orderId.toNumber()}`
					);
					this.throttledNodes.set(
						this.getNodeToFillSignature(filledNode),
						Date.now()
					);
				} else if (log.length > 50) {
					// probably rawe event data...?
					successCount++;
				} else {
					logger.info(` how parse log?: ${log}`);
				}

				nextIsFillRecord = false;
			} else if (this.isLogFillOrder(log)) {
				nextIsFillRecord = true;
				ixIdx++;
			}
		}

		this.metrics?.recordFilledOrder(
			this.clearingHouse.provider.wallet.publicKey,
			this.name,
			successCount
		);
	}

	private async tryBulkFillNodes(
		nodesToFill: Array<NodeToFill>
	): Promise<TransactionSignature> {
		const tx = new Transaction();
		// const maxTxSize = 1232;
		const maxTxSize = 1000;

		/**
		 * At all times, the running Tx size is:
		 * - signatures (compact-u16 array, 64 bytes per elem)
		 * - message header (3 bytes)
		 * - affected accounts (compact-u16 array, 32 bytes per elem)
		 * - previous block hash (32 bytes)
		 * - message instructions (
		 * 		- progamIdIdx (1 byte)
		 * 		- accountsIdx (compact-u16, 1 byte per elem)
		 *		- instruction data (compact-u16, 1 byte per elem)
		 */
		let runningTxSize = 0;

		const uniqueAccounts = new Set<string>();
		uniqueAccounts.add(this.clearingHouse.provider.wallet.publicKey.toString()); // fee payer goes first

		// first ix is compute budget
		const computeBudgetIx = ComputeBudgetProgram.requestUnits({
			units: 4_000_000,
			additionalFee: 0,
		});
		computeBudgetIx.keys.forEach((key) =>
			uniqueAccounts.add(key.pubkey.toString())
		);
		uniqueAccounts.add(computeBudgetIx.programId.toString());
		tx.add(computeBudgetIx);

		// initialize the barebones transaction
		// signatures
		runningTxSize += this.calcCompactU16EncodedSize(new Array(1), 64);
		// message header
		runningTxSize += 3;
		// accounts
		runningTxSize += this.calcCompactU16EncodedSize(
			new Array(uniqueAccounts.size),
			32
		);
		// block hash
		runningTxSize += 32;
		runningTxSize += this.calcIxEncodedSize(computeBudgetIx);

		const txPackerStart = Date.now();
		const nodesSent: Array<NodeToFill> = [];
		let idxUsed = 0;
		for (const nodeToFill of nodesToFill) {
			const { makerInfo, chUser, referrerInfo } = await this.getNodeFillInfo(
				nodeToFill
			);

			const ix = await this.clearingHouse.getFillOrderIx(
				chUser.getUserAccountPublicKey(),
				chUser.getUserAccount(),
				nodeToFill.node.order,
				makerInfo,
				referrerInfo
			);

			// first estimate new tx size with this additional ix and new accounts
			const ixKeys = ix.keys.map((key) => key.pubkey);
			const newAccounts = ixKeys
				.concat(ix.programId)
				.filter((key) => !uniqueAccounts.has(key.toString()));
			const newIxCost = this.calcIxEncodedSize(ix);
			const additionalAccountsCost =
				newAccounts.length > 0
					? this.calcCompactU16EncodedSize(newAccounts, 32) - 1
					: 0;

			// check it; appears we cannot send exactly maxTxSize.
			if (runningTxSize + newIxCost + additionalAccountsCost >= maxTxSize) {
				break;
			}

			// add to tx
			logger.info(
				`including tx ${chUser
					.getUserAccountPublicKey()
					.toString()}-${nodeToFill.node.order.orderId.toString()}`
			);
			tx.add(ix);
			runningTxSize += newIxCost + additionalAccountsCost;
			newAccounts.forEach((key) => uniqueAccounts.add(key.toString()));
			idxUsed++;
			nodesSent.push(nodeToFill);
		}
		logger.info(`txPacker took ${Date.now() - txPackerStart}ms`);

		if (nodesSent.length === 0) {
			logger.info('no ix');
			return '';
		}

		logger.info(
			`sending tx, ${
				uniqueAccounts.size
			} unique accounts, total ix: ${idxUsed}, calcd tx size: ${runningTxSize}, took ${
				Date.now() - txPackerStart
			}ms`
		);

		const txStart = Date.now();
		try {
			const { txSig } = await this.clearingHouse.txSender.send(
				tx,
				[],
				this.clearingHouse.opts
			);
			const duration = Date.now() - txStart;
			logger.info(`sent tx: ${txSig}, took: ${duration}ms`);
			this.metrics?.recordRpcDuration(
				this.clearingHouse.connection.rpcEndpoint,
				'send',
				duration,
				false,
				this.name
			);

			const parseLogsStart = Date.now();
			await this.processBulkFillTxLogs(nodesSent, txSig);
			const processBulkFillLogsDuration = Date.now() - parseLogsStart;
			logger.info(`parse logs took ${processBulkFillLogsDuration}ms`);
			this.metrics?.recordRpcDuration(
				this.clearingHouse.connection.rpcEndpoint,
				'processLogs',
				processBulkFillLogsDuration,
				false,
				this.name
			);

			this.metrics?.recordFilledOrder(
				this.clearingHouse.provider.wallet.publicKey,
				this.name,
				nodesSent.length
			);

			return txSig;
		} catch (e) {
			logger.error(`failed to send packed tx:`);
			console.error(e);
			const simError = e as SendTransactionError;
			for (const log of simError.logs) {
				logger.error(`${log}`);
			}
		}
	}

	private async tryFill() {
		const startTime = Date.now();
		let ran = false;
		try {
			await tryAcquire(this.periodicTaskMutex).runExclusive(async () => {
				await this.dlobMutex.runExclusive(async () => {
					delete this.dlob;
					this.dlob = new DLOB(this.clearingHouse.getMarketAccounts(), true);
					this.metrics?.trackObjectSize('filler-dlob', this.dlob);
					await this.dlob.init(this.clearingHouse, this.userMap);
				});

				// 1) get all fillable nodes
				let fillableNodes: Array<NodeToFill> = [];
				for (const market of this.clearingHouse.getMarketAccounts()) {
					fillableNodes = fillableNodes.concat(
						await this.getFillableNodesForMarket(market)
					);
				}

				const filteredNodes = fillableNodes.filter((node) =>
					this.filterFillableNodes(node)
				);

				this.metrics?.recordFillableOrdersSeen(-1, filteredNodes.length);
				// fill the nodes
				const fillResult = await promiseTimeout(
					// this.tryFillNode(this.randomIndex(filteredNodes)),
					this.tryBulkFillNodes(filteredNodes),
					15000
				);

				if (fillResult === null) {
					logger.error(`Timeout tryFill, took ${Date.now() - startTime}ms`);
				}

				ran = true;
			});
		} catch (e) {
			if (e === E_ALREADY_LOCKED) {
				this.metrics?.recordMutexBusy(this.name);
			} else if (e === dlobMutexError) {
				logger.error(`${this.name} dlobMutexError timeout`);
			} else {
				throw e;
			}
		} finally {
			if (ran) {
				const duration = Date.now() - startTime;
				this.metrics?.recordRpcDuration(
					this.clearingHouse.connection.rpcEndpoint,
					'tryFill',
					duration,
					false,
					this.name
				);
				logger.info(`tryFill done, took ${duration}ms`);
			}
		}
	}
}
