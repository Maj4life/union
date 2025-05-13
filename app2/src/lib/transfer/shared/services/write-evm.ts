import { switchChain } from "$lib/services/transfer-ucs03-evm"
import { resolveSafeTx } from "$lib/transfer/shared/services/handlers/safe-hash.ts"
import type { EffectToExit, HasKey } from "$lib/types"
import { getLastConnectedWalletId } from "$lib/wallet/evm/config.svelte.ts"
import { ViemPublicClient, waitForTransactionReceipt, writeContract } from "@unionlabs/sdk/evm"
import { Data, Effect, Exit, flow, pipe, Predicate } from "effect"
import type { Simplify } from "effect/Types"
import type {
  Abi,
  Chain,
  ContractFunctionArgs,
  ContractFunctionName,
  Hash,
  PublicClient,
  WalletClient,
  WriteContractParameters,
} from "viem"

export type TransactionState = Data.TaggedEnum<{
  Filling: {}
  SwitchChainInProgress: {}
  SwitchChainComplete: { exit: EffectToExit<ReturnType<typeof switchChain>> }
  WriteContractInProgress: {}
  WriteContractComplete: { exit: EffectToExit<ReturnType<typeof writeContract>> }
  WaitForSafeWalletHash: { readonly hash: Hash } // the safeTxHash
  TransactionReceiptInProgress: { readonly hash: Hash } // on chain hash
  TransactionReceiptComplete: { exit: EffectToExit<ReturnType<typeof waitForTransactionReceipt>> }
}>
type ExitStates = HasKey<TransactionState, "exit">

export const TransactionState = Data.taggedEnum<TransactionState>()
export const {
  SwitchChainInProgress,
  SwitchChainComplete,
  WriteContractInProgress,
  WriteContractComplete,
  WaitForSafeWalletHash,
  TransactionReceiptInProgress,
  TransactionReceiptComplete,
  $is: is,
} = TransactionState

export const nextState = async <
  TAbi extends Abi,
  TFunctionName extends ContractFunctionName<TAbi, "nonpayable" | "payable"> = ContractFunctionName<
    TAbi,
    "nonpayable" | "payable"
  >,
  TArgs extends ContractFunctionArgs<
    TAbi,
    "nonpayable" | "payable",
    TFunctionName
  > = ContractFunctionArgs<TAbi, "nonpayable" | "payable", TFunctionName>,
>(
  ts: TransactionState,
  chain: Chain,
  publicClient: PublicClient,
  walletClient: WalletClient,
  params: WriteContractParameters<TAbi, TFunctionName, TArgs>,
): Promise<TransactionState> =>
  TransactionState.$match(ts, {
    Filling: () => SwitchChainInProgress(),

    SwitchChainInProgress: async () => {
      const isSafeWallet = getLastConnectedWalletId() === "safe" // safe wagmi connector does not support wagmiSwitchChain
      return isSafeWallet
        ? WriteContractInProgress()
        : SwitchChainComplete({
          exit: await Effect.runPromiseExit(switchChain(chain)),
        })
    },

    SwitchChainComplete: ({ exit }) =>
      exit._tag === "Failure" ? SwitchChainInProgress() : WriteContractInProgress(),

    WriteContractInProgress: async () =>
      WriteContractComplete({
        exit: await Effect.runPromiseExit(writeContract(walletClient, params)),
      }),

    WriteContractComplete: ({ exit }) => {
      if (exit._tag === "Failure") {
        return WriteContractInProgress()
      }

      const wallet = getLastConnectedWalletId()
      const hash = exit.value

      return wallet === "safe" // needed due to safe wagmi connector returns safeTx hash and not the onchain one
        ? WaitForSafeWalletHash({ hash })
        : TransactionReceiptInProgress({ hash })
    },

    WaitForSafeWalletHash: async ({ hash }) => {
      const resolvedExit = await Effect.runPromiseExit(resolveSafeTx(hash)) // TODO

      return resolvedExit._tag === "Failure"
        ? WaitForSafeWalletHash({ hash })
        : TransactionReceiptInProgress({ hash: resolvedExit.value })
    },

    TransactionReceiptInProgress: async ({ hash }) =>
      TransactionReceiptComplete({
        exit: await Effect.runPromiseExit(
          waitForTransactionReceipt(hash).pipe(
            Effect.provideService(ViemPublicClient, { client: publicClient }),
          ),
        ),
      }),

    TransactionReceiptComplete: () => ts,
  })

export const hasFailedExit = (state: TransactionState) =>
  "exit" in state && state.exit._tag === "Failure"

// TODO: make single-responsibility
export const isComplete = (state: TransactionState): string | false => {
  if (state._tag === "TransactionReceiptComplete" && state.exit._tag === "Success") {
    return state.exit.value.transactionHash
  }
  return false
}

// @ts-expect-error
export const hasSuccessfulExit: <T extends ExitStates>(
  _: T,
  // @ts-expect-error
) => _ is ExitToSuccess<T> = (_) =>
  pipe(
    _,
    Predicate.compose(
      Predicate.hasProperty("exit"),
      (x) => Exit.isSuccess(x.exit as Exit.Exit<any, any>),
    ),
  )
