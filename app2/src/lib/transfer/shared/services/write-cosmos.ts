import { switchChain } from "$lib/services/transfer-ucs03-cosmos"
import type { EffectToExit, HasKey } from "$lib/types"
import type { SigningCosmWasmClient } from "@cosmjs/cosmwasm-stargate"
import { executeContract } from "@unionlabs/sdk/cosmos"
import type { Chain } from "@unionlabs/sdk/schema"
import { Data, Effect, Exit, pipe, Predicate, Schedule } from "effect"

export type TransactionState = Data.TaggedEnum<{
  Filling: {}
  SwitchChainInProgress: {}
  SwitchChainComplete: { exit: EffectToExit<ReturnType<typeof switchChain>> }
  WriteContractInProgress: { signingClient: SigningCosmWasmClient }
  WriteContractComplete: {
    signingClient: SigningCosmWasmClient
    exit: EffectToExit<ReturnType<typeof executeContract>>
  }
}>
type ExitStates = HasKey<TransactionState, "exit">

export const TransactionState = Data.taggedEnum<TransactionState>()
export const {
  SwitchChainInProgress,
  SwitchChainComplete,
  WriteContractInProgress,
  WriteContractComplete,
  $is: is,
} = TransactionState

export const nextState = async (
  ts: TransactionState,
  chain: Chain,
  senderAddress: string,
  contractAddress: string,
  msg: Record<string, unknown>,
  funds?: ReadonlyArray<{ denom: string; amount: string }>,
): Promise<TransactionState> =>
  TransactionState.$match(ts, {
    Filling: () => {
      return SwitchChainInProgress()
    },
    SwitchChainInProgress: async () => {
      const switchResult = await Effect.runPromiseExit(switchChain(chain))
      return SwitchChainComplete({
        exit: switchResult,
      })
    },
    SwitchChainComplete: ({ exit }) => {
      if (exit._tag === "Failure") {
        console.error("[SwitchChainComplete] Chain switch failed with error:", exit.cause)
        console.log("[SwitchChainComplete] → Retrying SwitchChainInProgress")
        return SwitchChainInProgress()
      }
      console.log(
        "[SwitchChainComplete] Chain switch successful. → Moving to ExecuteContractInProgress",
      )
      return WriteContractInProgress({ signingClient: exit.value.signingClient })
    },
    WriteContractInProgress: async ({ signingClient }) => {
      const retryableExecute = executeContract(
        signingClient,
        senderAddress,
        contractAddress,
        msg,
        funds,
      ).pipe(
        Effect.retry({
          while: error => error.message.includes("429"),
          schedule: Schedule.fibonacci("1 second"),
        }),
      )

      return WriteContractComplete({
        signingClient,
        exit: await Effect.runPromiseExit(retryableExecute),
      })
    },

    WriteContractComplete: ({ signingClient, exit }) => {
      if (exit._tag === "Failure") {
        console.error("[ExecuteContractComplete] Contract execution failed with error:", exit.cause)
        console.log("[ExecuteContractComplete] → Retrying ExecuteContractInProgress")
        return WriteContractInProgress({ signingClient })
      }
      console.log("ExecuteContractComplete] Contract execution successful. Transaction complete!")
      return ts
    },
  })

export const hasFailedExit = (state: TransactionState) =>
  "exit" in state && state.exit._tag === "Failure"

// TODO: make single-responsibility
export const isComplete = (state: TransactionState): string | false => {
  if (state._tag === "WriteContractComplete" && state.exit._tag === "Success") {
    return state.exit.value.transactionHash
  }
  return false
}

// TODO: reinvestigate type narrowing
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
