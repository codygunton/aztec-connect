import { EthAddress } from '@aztec/barretenberg/address';
import { Asset } from '@aztec/barretenberg/blockchain';
import { DefiInteractionNote, packInteractionNotes } from '@aztec/barretenberg/note_algorithms';
import { InnerProofData, RollupProofData } from '@aztec/barretenberg/rollup_proof';
import { Block } from '@aztec/barretenberg/block_source';
import { Signer } from 'ethers';
import { ethers } from 'hardhat';
import {
  evmSnapshot,
  evmRevert,
  advanceBlocksHardhat,
  blocksToAdvanceHardhat,
} from '../../ganache/hardhat_chain_manipulation';
import {
  createAccountProof,
  createDefiClaimProof,
  createDefiDepositProof,
  createDepositProof,
  createRollupProof,
  createSendProof,
  createWithdrawProof,
  DefiInteractionData,
  mergeInnerProofs,
} from './fixtures/create_mock_proof';
import { mockAsyncBridge } from './fixtures/setup_defi_bridges';
import { setupTestRollupProcessor } from './fixtures/setup_upgradeable_test_rollup_processor';
import { TestRollupProcessor } from './fixtures/test_rollup_processor';

jest.setTimeout(60000 * 2);

describe('rollup_processor: extract defi notes', () => {
  let rollupProcessor: TestRollupProcessor;
  let signers: Signer[];
  let addresses: EthAddress[];
  let assets: Asset[];
  let assetAddresses: EthAddress[];

  let snapshot: string;

  const escapeBlockLowerBound = 80;
  const escapeBlockUpperBound = 100;

  const txCallDataLimit = 120 * 1024;

  const decodeRollup = (block: Block) => {
    const rollup = RollupProofData.decode(block.encodedRollupProofData);
    // Coax lazy init of txId
    rollup.innerProofData.forEach(x => x.txId);
    return rollup;
  };

  beforeAll(async () => {
    signers = await ethers.getSigners();
    addresses = await Promise.all(signers.map(async u => EthAddress.fromString(await u.getAddress())));
    ({ rollupProcessor, assets, assetAddresses } = await setupTestRollupProcessor(signers, {
      numberOfTokenAssets: 1,
      escapeBlockLowerBound,
      escapeBlockUpperBound,
    }));
    // Advance into block region where escapeHatch is active.
    const blocks = await blocksToAdvanceHardhat(escapeBlockLowerBound, escapeBlockUpperBound, ethers.provider);
    await advanceBlocksHardhat(blocks, ethers.provider);
  });

  beforeEach(async () => {
    snapshot = await evmSnapshot();
  });

  afterEach(async () => {
    await evmRevert(snapshot);
  });

  it('should extract defi notes from blocks between rollups', async () => {
    const inputAssetIdA = 1;
    const outputValueA = 7n;
    const { bridgeCallData } = await mockAsyncBridge(signers[0], rollupProcessor, assetAddresses, {
      inputAssetIdA,
      outputAssetIdA: 0,
      outputValueA,
    });
    const numberOfBridgeCalls = RollupProofData.NUM_BRIDGE_CALLS_PER_BLOCK;

    const userAAddress = addresses[1];
    const userA = signers[1];

    const depositAmount = 30n;
    const sendAmount = 6n;
    const defiDepositAmount0 = 12n;
    const defiDepositAmount1 = 8n;
    const withdrawalAmount = 10n;

    const innerProofOutputs = [
      await createDepositProof(depositAmount, userAAddress, userA, inputAssetIdA),
      mergeInnerProofs([createAccountProof(), createSendProof(inputAssetIdA, sendAmount)]),
      mergeInnerProofs([
        createDefiDepositProof(bridgeCallData, defiDepositAmount0),
        createDefiDepositProof(bridgeCallData, defiDepositAmount1),
      ]),
      createWithdrawProof(withdrawalAmount, userAAddress, inputAssetIdA),
      createDefiClaimProof(bridgeCallData),
    ];

    const expectedInteractionResult = [
      new DefiInteractionNote(bridgeCallData, numberOfBridgeCalls * 2, 12n, outputValueA, 0n, true),
      new DefiInteractionNote(bridgeCallData, numberOfBridgeCalls * 2 + 1, 8n, outputValueA, 0n, true),
    ];
    const previousDefiInteractionHash = packInteractionNotes(expectedInteractionResult, numberOfBridgeCalls);

    // Deposit to contract.
    await assets[inputAssetIdA].approve(depositAmount, userAAddress, rollupProcessor.address);
    await rollupProcessor.depositPendingFunds(inputAssetIdA, depositAmount, undefined, {
      signingAddress: userAAddress,
    });

    const txProofs = [];
    for (let i = 0; i < innerProofOutputs.length; ++i) {
      const proof = createRollupProof(signers[0], innerProofOutputs[i], {
        rollupId: i,
        defiInteractionData:
          i === 2
            ? [
                new DefiInteractionData(bridgeCallData, defiDepositAmount0),
                new DefiInteractionData(bridgeCallData, defiDepositAmount1),
              ]
            : [],
        previousDefiInteractionHash: i === 4 ? previousDefiInteractionHash : undefined,
      });
      txProofs.push(proof);
    }

    // send the first 3 txs, this will take us beyond the defi deposits
    for (let i = 0; i < 3; i++) {
      const txs = await rollupProcessor.createRollupTxs(
        txProofs[i].encodedProofData,
        txProofs[i].signatures,
        txProofs[i].offchainTxData,
        txCallDataLimit,
      );
      await rollupProcessor.sendRollupTxs(txs);
    }

    // now finalise the 2 defi deposits
    await rollupProcessor.processAsyncDefiInteraction(expectedInteractionResult[0].nonce);
    await rollupProcessor.processAsyncDefiInteraction(expectedInteractionResult[1].nonce);

    // now send the last 2 tx rollups
    for (let i = 3; i < txProofs.length; i++) {
      const txs = await rollupProcessor.createRollupTxs(
        txProofs[i].encodedProofData,
        txProofs[i].signatures,
        txProofs[i].offchainTxData,
        txCallDataLimit,
      );
      await rollupProcessor.sendRollupTxs(txs);
    }

    const blocks = await rollupProcessor.getRollupBlocksFrom(0, 1);
    expect(blocks.length).toBe(5);

    {
      const block = blocks[0];
      const rollup = decodeRollup(block);
      const { innerProofs, offchainTxData } = innerProofOutputs[0];
      expect(block).toMatchObject({
        rollupId: 0,
        rollupSize: 2,
        interactionResult: [],
        offchainTxData,
      });
      expect(rollup).toMatchObject({
        rollupId: 0,
        dataStartIndex: 0,
        innerProofData: [innerProofs[0], InnerProofData.PADDING],
      });
    }

    const numRealTxsInRollup = 4;

    {
      const block = blocks[1];
      const rollup = decodeRollup(block);
      const { innerProofs, offchainTxData } = innerProofOutputs[1];
      expect(block).toMatchObject({
        rollupId: 1,
        rollupSize: 2,
        interactionResult: [],
        offchainTxData,
      });
      expect(rollup).toMatchObject({
        rollupId: 1,
        dataStartIndex: 1 * numRealTxsInRollup,
        innerProofData: innerProofs,
      });
    }

    {
      const block = blocks[2];
      const rollup = decodeRollup(block);
      const { innerProofs, offchainTxData } = innerProofOutputs[2];
      expect(block).toMatchObject({
        rollupId: 2,
        rollupSize: 2,
        offchainTxData,
      });
      expect(rollup).toMatchObject({
        rollupId: 2,
        dataStartIndex: 2 * numRealTxsInRollup,
        innerProofData: innerProofs,
      });
    }

    {
      const block = blocks[3];
      const rollup = decodeRollup(block);
      const { innerProofs, offchainTxData } = innerProofOutputs[3];
      expect(block).toMatchObject({
        rollupId: 3,
        rollupSize: 2,
        offchainTxData,
        interactionResult: expectedInteractionResult,
      });
      expect(rollup).toMatchObject({
        rollupId: 3,
        dataStartIndex: 3 * numRealTxsInRollup,
        innerProofData: [innerProofs[0], InnerProofData.PADDING],
      });
    }

    {
      const block = blocks[4];
      const rollup = decodeRollup(block);
      const { innerProofs, offchainTxData } = innerProofOutputs[4];
      expect(block).toMatchObject({
        rollupId: 4,
        rollupSize: 2,
        offchainTxData,
        interactionResult: [],
      });
      expect(rollup).toMatchObject({
        rollupId: 4,
        dataStartIndex: 4 * numRealTxsInRollup,
        innerProofData: [innerProofs[0], InnerProofData.PADDING],
      });
    }
  });
});
