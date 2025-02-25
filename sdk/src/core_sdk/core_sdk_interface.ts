import { EthAddress, GrumpkinAddress } from '@aztec/barretenberg/address';
import { AssetValue } from '@aztec/barretenberg/asset';
import { BridgeCallData } from '@aztec/barretenberg/bridge_call_data';
import { SchnorrSignature } from '@aztec/barretenberg/crypto';
import { DepositTx, RollupProviderStatus } from '@aztec/barretenberg/rollup_provider';
import { TxId } from '@aztec/barretenberg/tx_id';
import { CoreUserTx } from '../core_tx';
import { Note } from '../note';
import { AccountProofInput, JoinSplitProofInput, ProofOutput } from '../proofs';
import { CoreSdkOptions } from './core_sdk_options';
import { SdkEvent, SdkStatus } from './sdk_status';

export interface CoreSdkInterface {
  on(event: SdkEvent.UPDATED_USER_STATE, listener: (userId: GrumpkinAddress) => void): this;
  on(event: SdkEvent.UPDATED_WORLD_STATE, listener: (syncedToRollup: number, latestRollupId: number) => void): this;
  on(event: SdkEvent.DESTROYED, listener: () => void): this;

  init(options: CoreSdkOptions): Promise<void>;

  run(): Promise<void>;

  destroy(): Promise<void>;

  getLocalStatus(): Promise<SdkStatus>;

  getRemoteStatus(): Promise<RollupProviderStatus>;

  isAccountRegistered(accountPublicKey: GrumpkinAddress, includePending: boolean): Promise<boolean>;

  isAliasRegistered(alias: string, includePending: boolean): Promise<boolean>;

  isAliasRegisteredToAccount(
    accountPublicKey: GrumpkinAddress,
    alias: string,
    includePending: boolean,
  ): Promise<boolean>;

  getAccountPublicKey(alias: string): Promise<GrumpkinAddress | undefined>;

  getTxFees(assetId: number): Promise<AssetValue[][]>;

  getDefiFees(bridgeCallData: BridgeCallData): Promise<AssetValue[]>;

  getPendingDepositTxs(): Promise<DepositTx[]>;

  createDepositProof(
    assetId: number,
    publicInput: bigint,
    privateOutput: bigint,
    depositor: EthAddress,
    recipient: GrumpkinAddress,
    recipientSpendingKeyRequired: boolean,
    txRefNo: number,
  ): Promise<ProofOutput>;

  createPaymentProofInput(
    userId: GrumpkinAddress,
    assetId: number,
    publicInput: bigint,
    publicOutput: bigint,
    privateInput: bigint,
    recipientPrivateOutput: bigint,
    senderPrivateOutput: bigint,
    noteRecipient: GrumpkinAddress | undefined,
    recipientSpendingKeyRequired: boolean,
    publicOwner: EthAddress | undefined,
    spendingPublicKey: GrumpkinAddress,
    allowChain: number,
  ): Promise<JoinSplitProofInput>;

  createPaymentProof(input: JoinSplitProofInput, txRefNo: number): Promise<ProofOutput>;

  createAccountProofSigningData(
    userId: GrumpkinAddress,
    alias: string,
    migrate: boolean,
    spendingPublicKey: GrumpkinAddress,
    newAccountPublicKey?: GrumpkinAddress,
    newSpendingPublicKey1?: GrumpkinAddress,
    newSpendingPublicKey2?: GrumpkinAddress,
  ): Promise<Buffer>;

  createAccountProofInput(
    userId: GrumpkinAddress,
    spendingPublicKey: GrumpkinAddress,
    migrate: boolean,
    newAlias: string | undefined,
    newSpendingPublicKey1: GrumpkinAddress | undefined,
    newSpendingPublicKey2: GrumpkinAddress | undefined,
    newAccountPrivateKey: Buffer | undefined,
  ): Promise<AccountProofInput>;

  createAccountProof(input: AccountProofInput, txRefNo: number): Promise<ProofOutput>;

  createDefiProofInput(
    userId: GrumpkinAddress,
    bridgeCallData: BridgeCallData,
    depositValue: bigint,
    inputNotes: Note[],
    spendingPublicKey: GrumpkinAddress,
  ): Promise<JoinSplitProofInput>;

  createDefiProof(input: JoinSplitProofInput, txRefNo: number): Promise<ProofOutput>;

  sendProofs(proofs: ProofOutput[]): Promise<TxId[]>;

  awaitSynchronised(timeout?: number): Promise<void>;

  isUserSynching(userId: GrumpkinAddress): Promise<boolean>;

  awaitUserSynchronised(userId: GrumpkinAddress, timeout?: number): Promise<void>;

  awaitSettlement(txId: TxId, timeout?: number): Promise<void>;

  awaitDefiDepositCompletion(txId: TxId, timeout?: number): Promise<void>;

  awaitDefiFinalisation(txId: TxId, timeout?: number): Promise<void>;

  awaitDefiSettlement(txId: TxId, timeout?: number): Promise<void>;

  getDefiInteractionNonce(txId: TxId): Promise<number | undefined>;

  userExists(userId: GrumpkinAddress): Promise<boolean>;

  getUsers(): Promise<GrumpkinAddress[]>;

  derivePublicKey(privateKey: Buffer): Promise<GrumpkinAddress>;

  constructSignature(message: Buffer, privateKey: Buffer): Promise<SchnorrSignature>;

  addUser(accountPrivateKey: Buffer, noSync?: boolean): Promise<GrumpkinAddress>;

  removeUser(userId: GrumpkinAddress): Promise<void>;

  getUserSyncedToRollup(userId: GrumpkinAddress): Promise<number>;

  getSpendingKeys(userId: GrumpkinAddress): Promise<Buffer[]>;

  getBalances(userId: GrumpkinAddress): Promise<AssetValue[]>;

  getBalance(userId: GrumpkinAddress, assetId: number): Promise<bigint>;

  getSpendableSum(
    userId: GrumpkinAddress,
    assetId: number,
    spendingKeyRequired?: boolean,
    excludePendingNotes?: boolean,
  ): Promise<bigint>;

  getSpendableSums(
    userId: GrumpkinAddress,
    spendingKeyRequired?: boolean,
    excludePendingNotes?: boolean,
  ): Promise<AssetValue[]>;

  getMaxSpendableValue(
    userId: GrumpkinAddress,
    assetId: number,
    spendingKeyRequired?: boolean,
    excludePendingNotes?: boolean,
    numNotes?: number,
  ): Promise<bigint>;

  pickNotes(
    userId: GrumpkinAddress,
    assetId: number,
    value: bigint,
    spendingKeyRequired?: boolean,
    excludePendingNotes?: boolean,
  ): Promise<Note[]>;

  pickNote(
    userId: GrumpkinAddress,
    assetId: number,
    value: bigint,
    spendingKeyRequired?: boolean,
    excludePendingNotes?: boolean,
  ): Promise<Note | undefined>;

  getUserTxs(userId: GrumpkinAddress): Promise<CoreUserTx[]>;
}
