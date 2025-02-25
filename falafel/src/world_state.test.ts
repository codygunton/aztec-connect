import { EthAddress } from '@aztec/barretenberg/address';
import { toBigIntBE, toBufferBE } from '@aztec/barretenberg/bigint_buffer';
import { Blockchain, TxHash, TxType } from '@aztec/barretenberg/blockchain';
import { Block } from '@aztec/barretenberg/block_source';
import { BridgeCallData } from '@aztec/barretenberg/bridge_call_data';
import { ProofData, ProofId } from '@aztec/barretenberg/client_proofs';
import { NoteAlgorithms } from '@aztec/barretenberg/note_algorithms';
import { InnerProofData, RollupProofData } from '@aztec/barretenberg/rollup_proof';
import { BridgeConfig } from '@aztec/barretenberg/rollup_provider';
import { numToUInt32BE } from '@aztec/barretenberg/serialize';
import { sleep } from '@aztec/barretenberg/sleep';
import { RollupTreeId, WorldStateDb } from '@aztec/barretenberg/world_state_db';
import { randomBytes } from 'crypto';
import { EventEmitter } from 'stream';
import { RollupDao } from './entity';
import { TxDao } from './entity/tx';
import { Metrics } from './metrics';
import { RollupDb } from './rollup_db';
import { RollupPipeline, RollupPipelineFactory } from './rollup_pipeline';
import { TxFeeResolver } from './tx_fee_resolver';
import { WorldState } from './world_state';

type Mockify<T> = {
  [P in keyof T]: jest.Mock;
};

const generatePaymentProof = () => {
  const innerProof = new InnerProofData(
    ProofId.SEND,
    randomBytes(32),
    randomBytes(32),
    randomBytes(32),
    randomBytes(32),
    numToUInt32BE(0),
    randomBytes(32),
    numToUInt32BE(0),
  );
  return innerProof;
};

const blockTimer = {
  end: () => {},
};

const roots = [randomBytes(32), randomBytes(32), randomBytes(32), randomBytes(32)];
const subTreeRoots = [randomBytes(32), randomBytes(32), randomBytes(32), randomBytes(32)];
const EMPTY_BUFFER = Buffer.alloc(32);

const nextRollupId = 2;
const getNextRollupId = () => nextRollupId;

const buildRollupProofData = (isOurs: boolean) => {
  const proof = new RollupProofData(
    nextRollupId,
    1,
    0,
    EMPTY_BUFFER,
    isOurs ? roots[RollupTreeId.DATA] : randomBytes(32),
    EMPTY_BUFFER,
    isOurs ? roots[RollupTreeId.NULL] : randomBytes(32),
    EMPTY_BUFFER,
    isOurs ? roots[RollupTreeId.ROOT] : randomBytes(32),
    EMPTY_BUFFER,
    isOurs ? roots[RollupTreeId.DEFI] : randomBytes(32),
    Array.from({ length: RollupProofData.NUM_BRIDGE_CALLS_PER_BLOCK }).map(() => EMPTY_BUFFER), // bridgeCallDatas
    Array.from({ length: RollupProofData.NUM_BRIDGE_CALLS_PER_BLOCK }).map(() => 0n), // defiDepositSums
    Array.from({ length: RollupProofData.NUMBER_OF_ASSETS }).map(() => 1 << 30), // assetIds value 1 << 30 is an invalid asset ID
    Array.from({ length: RollupProofData.NUMBER_OF_ASSETS }).map(() => 0n), // totalTxFees
    Array.from({ length: RollupProofData.NUM_BRIDGE_CALLS_PER_BLOCK }).map(() => EMPTY_BUFFER), // defiInteractionNotes
    EMPTY_BUFFER,
    EMPTY_BUFFER,
    1,
    [generatePaymentProof()],
  );
  return proof;
};

const createDummyBlock = (isOurs = true) => {
  const rollupProofData = buildRollupProofData(isOurs);
  const block = new Block(
    TxHash.random(),
    new Date(),
    nextRollupId,
    8,
    rollupProofData.encode(),
    rollupProofData.innerProofData.map(() => randomBytes(32)), // off chain tx data
    [],
    1000000,
    20n ** 10n,
  );
  return block;
};

const buildPendingDepositKey = (asset: number, owner: EthAddress) => {
  return asset.toString().concat(owner.toString());
};

const buildTxDao = ({
  id = 12345,
  nullifier1 = randomBytes(32),
  nullifier2 = randomBytes(32),
  noteCommitment1 = randomBytes(32),
  noteCommitment2 = randomBytes(32),
  proofId = ProofId.SEND,
  publicAssetId = 0,
  publicOwner = EthAddress.ZERO,
  publicValue = 0n,
  backwardLink = randomBytes(32),
} = {}) => {
  const proofDataBufferArray = Array.from({ length: ProofData.NUM_PUBLIC_INPUTS }).map(() => Buffer.alloc(32));
  // the nullifiers are in indexes 3 and 4, note commitments in 1 and 2
  proofDataBufferArray[0] = numToUInt32BE(proofId, 32);
  proofDataBufferArray[1] = noteCommitment1;
  proofDataBufferArray[2] = noteCommitment2;
  proofDataBufferArray[3] = nullifier1;
  proofDataBufferArray[4] = nullifier2;
  // publicValue, publicOwner and publicAssetId are in positions 5, 6 and 7
  proofDataBufferArray[5] = toBufferBE(publicValue, 32);
  proofDataBufferArray[6] = publicOwner.toBuffer32();
  proofDataBufferArray[7] = numToUInt32BE(publicAssetId, 32);
  // backward link in 14
  proofDataBufferArray[14] = backwardLink;
  const proofData = Buffer.concat(proofDataBufferArray);
  const txDao = new TxDao({
    id: numToUInt32BE(id),
    proofData,
    offchainTxData: Buffer.alloc(32),
  });
  return txDao;
};

const BASE_GAS = 20000;
const DEFI_TX_GAS = 50000;
const DEFI_TX_PLUS_BASE_GAS = BASE_GAS + DEFI_TX_GAS;
const DEFAULT_BRIDGE_GAS_LIMIT = 1000000;
const DEFAULT_DEFI_BATCH_SIZE = 10;

const bridgeConfigs: BridgeConfig[] = [
  {
    bridgeCallData: 1n,
    numTxs: 5,
    gas: 1000000,
    rollupFrequency: 2,
  },
  {
    bridgeCallData: 2n,
    numTxs: 10,
    gas: 5000000,
    rollupFrequency: 3,
  },
  {
    bridgeCallData: 3n,
    numTxs: 3,
    gas: 90000,
    rollupFrequency: 4,
  },
  {
    bridgeCallData: 4n,
    numTxs: 6,
    gas: 3000000,
    rollupFrequency: 1,
  },
  {
    bridgeCallData: 5n,
    numTxs: 2,
    gas: 8000000,
    rollupFrequency: 7,
  },
  {
    bridgeCallData: 6n,
    numTxs: 20,
    gas: 3000000,
    rollupFrequency: 8,
  },
];

const randomInt = (to = 2 ** 32 - 1) => Math.floor(Math.random() * (to + 1));
const txTypeToProofId = (txType: TxType) => (txType < TxType.WITHDRAW_HIGH_GAS ? txType + 1 : txType);

const mockTx = (
  id: number,
  {
    txType = TxType.TRANSFER,
    txFeeAssetId = 0,
    excessGas = 0,
    creationTime = new Date(new Date('2021-06-20T11:43:00+01:00').getTime() + id), // ensures txs are ordered by id
    bridgeCallData = new BridgeCallData(randomInt(), 1, 0).toBigInt(),
    noteCommitment1 = randomBytes(32),
    noteCommitment2 = randomBytes(32),
    backwardLink = Buffer.alloc(32),
    allowChain = numToUInt32BE(2, 32),
  } = {},
) =>
  ({
    id: Buffer.from([id]),
    txType,
    created: creationTime,
    excessGas,
    proofData: Buffer.concat([
      numToUInt32BE(txTypeToProofId(txType), 32),
      noteCommitment1,
      noteCommitment2,
      randomBytes(6 * 32),
      toBufferBE(0n, 32),
      numToUInt32BE(txFeeAssetId, 32),
      toBufferBE(bridgeCallData, 32),
      randomBytes(3 * 32),
      backwardLink,
      allowChain,
    ]),
  } as any as TxDao);

const getSingleBridgeCost = (bridgeCallData: bigint) => {
  const bridgeConfig = bridgeConfigs.find(bc => bc.bridgeCallData === bridgeCallData);
  if (!bridgeConfig) {
    throw new Error(`Requested cost for invalid bridgeCallData: ${bridgeCallData.toString()}`);
  }
  const { gas, numTxs } = bridgeConfig;
  const single = gas / numTxs;
  return gas % numTxs ? single + 1 : single;
};

describe('world_state', () => {
  let worldState: WorldState;
  let rollupDb: Mockify<RollupDb>;
  let worldStateDb: Mockify<WorldStateDb>;
  let noteAlgorithms: Mockify<NoteAlgorithms>;
  let metrics: Mockify<Metrics>;
  let pipelineFactory: Mockify<RollupPipelineFactory>;
  let blockchain: Mockify<Blockchain>;
  let txFeeResolver: Mockify<TxFeeResolver>;
  let pipeline: Mockify<RollupPipeline>;

  const mockDefiBridgeTx = (id: number, gas: number, bridgeCallData: bigint, assetId = 0) =>
    mockTx(id, {
      txType: TxType.DEFI_DEPOSIT,
      excessGas: gas - (DEFI_TX_PLUS_BASE_GAS + txFeeResolver.getSingleBridgeTxGas(bridgeCallData)),
      txFeeAssetId: assetId,
      bridgeCallData,
    });

  let pendingTxs: TxDao[] = [];
  let processedTxs: TxDao[] = [];
  const nullifiers: { [key: string]: Buffer } = {};
  const pendingDeposits: { [key: string]: bigint } = {};
  let rollupStore: { [key: number]: RollupDao } = {};

  beforeEach(() => {
    rollupStore = {};

    rollupDb = {
      getSettledRollups: jest.fn().mockResolvedValue([]),
      getNextRollupId: jest.fn().mockImplementation(() => getNextRollupId()),
      deleteUnsettledRollups: jest.fn(),
      deleteOrphanedRollupProofs: jest.fn(),
      deletePendingTxs: jest.fn(),
      getRollupProof: jest.fn().mockResolvedValue(undefined),
      addRollup: jest.fn().mockImplementation((rollupDao: RollupDao) => {
        rollupStore[rollupDao.id] = rollupDao;
      }),
      getAssetMetrics: jest.fn().mockReturnValue(undefined),
      getBridgeMetricsForRollup: jest.fn(),
      getLastBridgeMetrics: jest.fn(),
      getRollup: jest.fn().mockImplementation((id: number) => rollupStore[id]),
      getPendingTxs: jest.fn().mockImplementation(() => {
        return pendingTxs;
      }),
      getUnsettledTxCount: jest.fn().mockResolvedValue(0),
      deleteTxsById: jest.fn(),
    } as Mockify<RollupDb>;

    worldStateDb = {
      start: jest.fn(),
      rollback: jest.fn(),
      commit: jest.fn(),
      getSize: jest.fn().mockReturnValue(1024n),
      put: jest.fn(),
      getRoot: jest.fn().mockImplementation((id: RollupTreeId) => roots[id]),
      getSubtreeRoot: jest.fn().mockImplementation((id: RollupTreeId) => subTreeRoots[id]),
      get: jest.fn().mockImplementation((id: RollupTreeId, index: bigint) => {
        if (id == RollupTreeId.NULL) {
          return nullifiers[index.toString()] ?? Buffer.alloc(32);
        }
        return randomBytes(32);
      }),
      stop: jest.fn(),
    } as Mockify<WorldStateDb>;

    blockchain = new (class extends EventEmitter {
      getBlocks = jest.fn().mockResolvedValue([]);
      getChainId = jest.fn().mockResolvedValue(1);
      start = jest.fn();
      getRollupBalance = jest.fn().mockResolvedValue(0n);
      getUserPendingDeposit = jest.fn().mockImplementation((asset: number, owner: EthAddress) => {
        const key = buildPendingDepositKey(asset, owner);
        return pendingDeposits[key] ?? 0n;
      });
      stop = jest.fn();
    })() as Mockify<Blockchain>;

    pipeline = {
      getProcessedTxs: jest.fn().mockImplementation(() => processedTxs),
      start: jest.fn().mockImplementation(async () => {}),
      stop: jest.fn().mockImplementation(async () => {}),
    } as Mockify<RollupPipeline>;

    pipelineFactory = {
      create: jest.fn().mockReturnValue(pipeline),
      getRollupSize: jest.fn().mockReturnValue(1024),
    } as Mockify<RollupPipelineFactory>;

    metrics = {
      rollupReceived: jest.fn(),
      processBlockTimer: jest.fn().mockImplementation(() => {
        return blockTimer.end;
      }),
    } as Mockify<Metrics>;

    txFeeResolver = {
      getSingleBridgeTxGas: jest.fn().mockImplementation((bridgeCallData: bigint) => {
        const bridgeConfig = bridgeConfigs.find(b => b.bridgeCallData === bridgeCallData);
        const gas = bridgeConfig?.gas ?? DEFAULT_BRIDGE_GAS_LIMIT;
        const numTxs = bridgeConfig?.numTxs ?? DEFAULT_DEFI_BATCH_SIZE;
        return gas / numTxs;
      }),
      getFullBridgeGas: jest.fn().mockImplementation((bridgeCallData: bigint) => {
        const bridgeConfig = bridgeConfigs.find(b => b.bridgeCallData === bridgeCallData);
        return bridgeConfig?.gas ?? DEFAULT_BRIDGE_GAS_LIMIT;
      }),
    } as Mockify<TxFeeResolver>;

    worldState = new WorldState(
      rollupDb,
      worldStateDb as any,
      blockchain,
      pipelineFactory as any,
      noteAlgorithms as any,
      metrics as any,
      txFeeResolver as any,
      1,
      () => {},
    );
  });

  it('can be started', () => {
    expect(async () => {
      await worldState.start();
    }).not.toThrow();
  });

  it('can process block', async () => {
    await worldState.start();
    blockchain.emit('block', createDummyBlock());
    await worldState.stop(true);
  });

  it('double spend should be rejected due to first nullifier', async () => {
    await worldState.start();
    const nullifier1 = randomBytes(32);
    const txDao = buildTxDao({
      id: 12345,
      nullifier1,
      nullifier2: randomBytes(32),
    });
    // load this into pending txs
    pendingTxs = [txDao];
    // nullifier 1 is already present
    const index = toBigIntBE(nullifier1).toString();
    nullifiers[index] = toBufferBE(1n, 32);
    blockchain.emit('block', createDummyBlock(false));
    await worldState.stop(true);
    expect(rollupDb.deleteTxsById).toHaveBeenCalledTimes(1);
    expect(rollupDb.deleteTxsById).toHaveBeenCalledWith([txDao.id]);
  });

  it('double spend should be rejected due to second nullifier', async () => {
    await worldState.start();
    const nullifier2 = randomBytes(32);
    const txDao = buildTxDao({
      id: 12345,
      nullifier1: randomBytes(32),
      nullifier2,
    });
    // load this into pending txs
    pendingTxs = [txDao];
    // nullifier 2 is already present
    const index = toBigIntBE(nullifier2).toString();
    nullifiers[index] = toBufferBE(1n, 32);
    blockchain.emit('block', createDummyBlock(false));
    await worldState.stop(true);
    expect(rollupDb.deleteTxsById).toHaveBeenCalledTimes(1);
    expect(rollupDb.deleteTxsById).toHaveBeenCalledWith([txDao.id]);
  });

  it('no txs are rejected if they do not match nullifiers', async () => {
    await worldState.start();
    const txDao1 = buildTxDao({
      id: 12345,
      nullifier1: randomBytes(32),
      nullifier2: randomBytes(32),
    });
    const txDao2 = buildTxDao({
      id: 12346,
      nullifier1: randomBytes(32),
      nullifier2: randomBytes(32),
    });
    // load these into pending txs
    pendingTxs = [txDao1, txDao2];
    // don't put the nullifiers into the tree
    blockchain.emit('block', createDummyBlock(false));
    await worldState.stop(true);
    expect(rollupDb.deleteTxsById).toHaveBeenCalledTimes(0);
  });

  it('tx is rejected if it breaches the pending deposit', async () => {
    await worldState.start();
    const publicAssetId = 0;
    const publicOwner = EthAddress.random();
    const publicValue = 10000n;
    const txDao = buildTxDao({
      proofId: ProofId.DEPOSIT,
      id: 12345,
      publicOwner,
      publicValue,
      publicAssetId,
    });
    // load these into pending txs
    pendingTxs = [txDao];
    // set a pending deposit lower than this tx is trying to spend
    pendingDeposits[buildPendingDepositKey(publicAssetId, publicOwner)] = 5000n;
    // don't put the nullifiers into the tree
    blockchain.emit('block', createDummyBlock(false));
    await worldState.stop(true);
    expect(rollupDb.deleteTxsById).toHaveBeenCalledTimes(1);
    expect(rollupDb.deleteTxsById).toHaveBeenCalledWith([txDao.id]);
  });

  it('txs are rejected once they breach the pending deposit', async () => {
    await worldState.start();
    const publicAssetId = 0;
    const publicOwner = EthAddress.random();
    const publicValue = 10000n;
    // load these into pending txs
    pendingTxs = Array.from({ length: 4 }).map((_, i) =>
      buildTxDao({
        proofId: ProofId.DEPOSIT,
        id: i + 12345,
        publicOwner,
        publicValue,
        publicAssetId,
      }),
    );
    // set a pending deposit that should mean txs 3 and 4 are discarded
    pendingDeposits[buildPendingDepositKey(publicAssetId, publicOwner)] = 29999n;
    // don't put the nullifiers into the tree
    blockchain.emit('block', createDummyBlock(false));
    await worldState.stop(true);
    expect(rollupDb.deleteTxsById).toHaveBeenCalledTimes(1);
    expect(rollupDb.deleteTxsById).toHaveBeenCalledWith(pendingTxs.slice(2).map(tx => tx.id));
  });

  it('pending deposit validation is based on asset and owner', async () => {
    await worldState.start();
    const publicAssetId1 = 0;
    const publicOwner1 = EthAddress.random();
    const publicAssetId2 = 1;
    const publicOwner2 = EthAddress.random();
    const publicValue = 10000n;
    const owner1Txs = Array.from({ length: 4 }).map((_, i) =>
      buildTxDao({
        proofId: ProofId.DEPOSIT,
        id: i + 12345,
        publicOwner: publicOwner1,
        publicValue,
        publicAssetId: publicAssetId1,
      }),
    );

    const owner2Txs = Array.from({ length: 4 }).map((_, i) =>
      buildTxDao({
        proofId: ProofId.DEPOSIT,
        id: i + 22345,
        publicOwner: publicOwner2,
        publicValue,
        publicAssetId: publicAssetId2,
      }),
    );
    pendingTxs = [...owner1Txs, ...owner2Txs];
    // set a pending deposit that should mean txs 3 and 4 are discarded
    pendingDeposits[buildPendingDepositKey(publicAssetId1, publicOwner1)] = 29999n;
    pendingDeposits[buildPendingDepositKey(publicAssetId2, publicOwner2)] = 39999n;
    // don't put the nullifiers into the tree
    blockchain.emit('block', createDummyBlock(false));
    await worldState.stop(true);
    expect(rollupDb.deleteTxsById).toHaveBeenCalledTimes(1);
    expect(rollupDb.deleteTxsById).toHaveBeenCalledWith([
      ...owner1Txs.slice(2).map(tx => tx.id),
      ...owner2Txs.slice(3).map(tx => tx.id),
    ]);
  });

  it('txs are still accepted even if after a tx that was rejected', async () => {
    await worldState.start();
    const publicAssetId1 = 0;
    const publicOwner1 = EthAddress.random();
    const publicAssetId2 = 0;
    const publicOwner2 = EthAddress.random();
    // for tx set 1 index 2 will breach and be rejected, 3 will be accepted, 4 rejected and 5 accepted
    // for tx set 2 indexes 1 and 2 will breach and be rejected, 3 will be accepted, 4 rejected and 5 accepted
    const publicValues = [10000n, 10000n, 10000n, 5000n, 5000n, 4000n];
    // load these into pending txs
    const txs1 = Array.from({ length: 6 }).map((_, i) =>
      buildTxDao({
        proofId: ProofId.DEPOSIT,
        id: i + 12345,
        publicOwner: publicOwner1,
        publicValue: publicValues[i],
        publicAssetId: publicAssetId1,
      }),
    );
    const txs2 = Array.from({ length: 6 }).map((_, i) =>
      buildTxDao({
        proofId: ProofId.DEPOSIT,
        id: i + 22345,
        publicOwner: publicOwner2,
        publicValue: publicValues[i],
        publicAssetId: publicAssetId2,
      }),
    );
    pendingTxs = [...txs1, ...txs2];
    // set a pending deposit that should mean txs 3 and 4 are discarded
    pendingDeposits[buildPendingDepositKey(publicAssetId1, publicOwner1)] = 29999n;
    pendingDeposits[buildPendingDepositKey(publicAssetId2, publicOwner2)] = 19999n;
    // don't put the nullifiers into the tree
    blockchain.emit('block', createDummyBlock(false));
    await worldState.stop(true);
    expect(rollupDb.deleteTxsById).toHaveBeenCalledTimes(1);
    expect(rollupDb.deleteTxsById).toHaveBeenCalledWith([txs1[2], txs1[4], txs2[1], txs2[2], txs2[4]].map(tx => tx.id));
  });

  it('tx is rejected if chains off note 1 of rejected tx', async () => {
    await worldState.start();
    const publicAssetId1 = 0;
    const publicOwner1 = EthAddress.random();
    const chainedCommitment = randomBytes(32);
    // index 2 will breach and be rejected, 3 will be accepted, 4 rejected and 5 accepted
    const publicValues = [10000n, 10000n, 10000n, 5000n, 5000n, 4000n];
    // load these into pending txs
    const txs1 = Array.from({ length: 6 }).map((_, i) =>
      buildTxDao({
        proofId: ProofId.DEPOSIT,
        id: i + 12345,
        publicOwner: publicOwner1,
        publicValue: publicValues[i],
        publicAssetId: publicAssetId1,
        noteCommitment1: i == 4 ? chainedCommitment : randomBytes(32),
      }),
    );
    const chainedTx = buildTxDao({
      proofId: ProofId.SEND,
      id: 23456,
      backwardLink: chainedCommitment,
    });
    pendingTxs = [...txs1, chainedTx];
    // set a pending deposit that should mean txs 3 and 4 are discarded
    pendingDeposits[buildPendingDepositKey(publicAssetId1, publicOwner1)] = 29999n;
    // don't put the nullifiers into the tree
    blockchain.emit('block', createDummyBlock(false));
    await worldState.stop(true);
    expect(rollupDb.deleteTxsById).toHaveBeenCalledTimes(1);
    expect(rollupDb.deleteTxsById).toHaveBeenCalledWith([txs1[2], txs1[4], chainedTx].map(tx => tx.id));
  });

  it('tx is rejected if chains off note 2 of rejected tx', async () => {
    await worldState.start();
    const publicAssetId1 = 0;
    const publicOwner1 = EthAddress.random();
    const chainedCommitment = randomBytes(32);
    // index 2 will breach and be rejected, 3 will be accepted, 4 rejected and 5 accepted
    const publicValues = [10000n, 10000n, 10000n, 5000n, 5000n, 4000n];
    // load these into pending txs
    const txs1 = Array.from({ length: 6 }).map((_, i) =>
      buildTxDao({
        proofId: ProofId.DEPOSIT,
        id: i + 12345,
        publicOwner: publicOwner1,
        publicValue: publicValues[i],
        publicAssetId: publicAssetId1,
        noteCommitment2: i == 4 ? chainedCommitment : randomBytes(32),
      }),
    );
    const chainedTx = buildTxDao({
      proofId: ProofId.SEND,
      id: 23456,
      backwardLink: chainedCommitment,
    });
    pendingTxs = [...txs1, chainedTx];
    // set a pending deposit that should mean txs 3 and 4 are discarded
    pendingDeposits[buildPendingDepositKey(publicAssetId1, publicOwner1)] = 29999n;
    // don't put the nullifiers into the tree
    blockchain.emit('block', createDummyBlock(false));
    await worldState.stop(true);
    expect(rollupDb.deleteTxsById).toHaveBeenCalledTimes(1);
    expect(rollupDb.deleteTxsById).toHaveBeenCalledWith([txs1[2], txs1[4], chainedTx].map(tx => tx.id));
  });

  it('all txs in chain are rejected', async () => {
    await worldState.start();
    const publicAssetId1 = 0;
    const publicOwner1 = EthAddress.random();
    const spentNullifier = randomBytes(32);
    const chainedCommitment1 = randomBytes(32);
    const chainedCommitment2 = randomBytes(32);
    const chainedCommitment3 = randomBytes(32);
    const chainedCommitment4 = randomBytes(32);
    const chainedCommitment5 = randomBytes(32);
    // index 2 will breach and be rejected, 3 will be accepted, 4 rejected and 5 accepted
    const publicValues = [10000n, 10000n, 10000n, 5000n, 5000n, 4000n];
    // load these into pending txs
    const txs1 = Array.from({ length: 6 }).map((_, i) =>
      buildTxDao({
        proofId: ProofId.DEPOSIT,
        id: i + 12345,
        publicOwner: publicOwner1,
        publicValue: publicValues[i],
        publicAssetId: publicAssetId1,
        noteCommitment1: i == 4 ? chainedCommitment1 : randomBytes(32),
      }),
    );
    // rejected due to spent nullifier
    const txWithSpentNote = buildTxDao({
      proofId: ProofId.SEND,
      id: 23455,
      nullifier1: spentNullifier,
      noteCommitment1: chainedCommitment4,
    });
    // nullifier 1 is already present
    const index = toBigIntBE(spentNullifier).toString();
    nullifiers[index] = toBufferBE(1n, 32);
    // this tx will be accepted
    const validTx = buildTxDao({
      proofId: ProofId.SEND,
      id: 23456,
      noteCommitment1: chainedCommitment3,
    });
    // rejected because chained to rejected txs1[4]
    const chainedTx1 = buildTxDao({
      proofId: ProofId.SEND,
      id: 23457,
      backwardLink: chainedCommitment1,
      noteCommitment2: chainedCommitment2,
    });
    // rejected because chained to rejected chainedTx1
    const chainedTx2 = buildTxDao({
      proofId: ProofId.SEND,
      id: 23458,
      backwardLink: chainedCommitment2,
    });
    // accepted because chained to validTx
    const chainedTx3 = buildTxDao({
      proofId: ProofId.SEND,
      id: 23459,
      backwardLink: chainedCommitment3,
    });
    // rejected because chained off txWithSpentNote
    const chainedTx4 = buildTxDao({
      proofId: ProofId.SEND,
      id: 23460,
      noteCommitment2: chainedCommitment5,
      backwardLink: chainedCommitment4,
    });
    // rejected because chained off chainedTx4
    const chainedTx5 = buildTxDao({
      proofId: ProofId.SEND,
      id: 23460,
      backwardLink: chainedCommitment5,
    });
    pendingTxs = [...txs1, validTx, txWithSpentNote, chainedTx1, chainedTx2, chainedTx3, chainedTx4, chainedTx5];
    // set a pending deposit that should mean txs 3 and 4 are discarded
    pendingDeposits[buildPendingDepositKey(publicAssetId1, publicOwner1)] = 29999n;
    // don't put the nullifiers into the tree
    blockchain.emit('block', createDummyBlock(false));
    await worldState.stop(true);
    expect(rollupDb.deleteTxsById).toHaveBeenCalledTimes(1);
    expect(rollupDb.deleteTxsById).toHaveBeenCalledWith(
      [txs1[2], txs1[4], txWithSpentNote, chainedTx1, chainedTx2, chainedTx4, chainedTx5].map(tx => tx.id),
    );
  });

  it('should generate a txPoolProfile from the pending txs', async () => {
    jest.setTimeout(10000);
    pendingTxs = [];
    await worldState.start();

    // check the empty state
    let txPoolProfile = await worldState.getTxPoolProfile();
    expect(txPoolProfile.pendingTxCount).toBe(0);

    // add one transaction
    pendingTxs = [
      buildTxDao({
        proofId: ProofId.DEPOSIT,
        id: 1,
      }),
    ];

    // wait for internal loop.
    await sleep(1000);

    txPoolProfile = await worldState.getTxPoolProfile();
    expect(txPoolProfile.pendingTxCount).toBe(1);

    const bridgeCallData1 = bridgeConfigs[0].bridgeCallData;
    pendingTxs = [
      buildTxDao({
        proofId: ProofId.DEPOSIT,
        id: 1,
      }),
      mockDefiBridgeTx(2, DEFI_TX_PLUS_BASE_GAS + getSingleBridgeCost(bridgeCallData1), bridgeCallData1),
    ];

    // wait for internal loop.
    await sleep(1000);

    txPoolProfile = await worldState.getTxPoolProfile();
    expect(txPoolProfile.pendingTxCount).toBe(2);
    expect(txPoolProfile.pendingBridgeStats).toEqual([
      { bridgeCallData: bridgeCallData1, gasAccrued: bridgeConfigs[0].gas / bridgeConfigs[0].numTxs },
    ]);

    // check all txs are accrued while the bridge is pending
    pendingTxs = [
      buildTxDao({
        proofId: ProofId.DEPOSIT,
        id: 1,
      }),
      mockDefiBridgeTx(2, DEFI_TX_PLUS_BASE_GAS + getSingleBridgeCost(bridgeCallData1), bridgeCallData1),
      mockDefiBridgeTx(3, DEFI_TX_PLUS_BASE_GAS + getSingleBridgeCost(bridgeCallData1), bridgeCallData1),
      mockDefiBridgeTx(4, DEFI_TX_PLUS_BASE_GAS + getSingleBridgeCost(bridgeCallData1), bridgeCallData1),
    ];

    processedTxs = [
      buildTxDao({
        proofId: ProofId.DEPOSIT,
        id: 1,
      }),
      mockDefiBridgeTx(2, DEFI_TX_PLUS_BASE_GAS + getSingleBridgeCost(bridgeCallData1), bridgeCallData1),
    ];

    // wait for internal loop.
    await sleep(1000);

    txPoolProfile = await worldState.getTxPoolProfile();
    expect(txPoolProfile.pendingTxCount).toBe(2);
    expect(txPoolProfile.pendingBridgeStats).toEqual([
      { bridgeCallData: bridgeCallData1, gasAccrued: (bridgeConfigs[0].gas / bridgeConfigs[0].numTxs) * 2 },
    ]);
  });
});
