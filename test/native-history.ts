import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { type ChangeSet, NativeRuntime } from "@bjornpagen/bumbledb"
import { Command, type History, type LocalBinding, RequestId } from "@bjornpagen/bumbledb-log"
import { Clock, Effect, Result, type Scope } from "effect"
import { io } from "../src/core/files.ts"
import { periodSpan } from "../src/core/time.ts"
import { mintId } from "../src/core/values.ts"
import { createHistory, type Draft, type LedgerHistory } from "../src/runtime.ts"
import type ledger from "../src/schema.ts"
import * as S from "../src/schema.ts"

export function withHistory<A, E>(
	run: (
		history: History<typeof ledger>,
		binding: LocalBinding,
		directory: string
	) => Effect.Effect<A, E, Scope.Scope | NativeRuntime>
) {
	return Effect.runPromise(
		Effect.gen(function* () {
			const directory = yield* Effect.acquireRelease(
				io("create test directory", () => fs.mkdtemp(path.join(os.tmpdir(), "wagie-tools-theory-"))),
				(directory) =>
					io("remove test directory", () => fs.rm(directory, { recursive: true, force: true })).pipe(
						Effect.orDie
					)
			)
			const { history, binding } = yield* createHistory(path.join(directory, "store"))
			return yield* run(history, binding, directory)
		}).pipe(Effect.scoped, Effect.provide(NativeRuntime.layer()))
	)
}

export const apply = (history: LedgerHistory, changes: ChangeSet<typeof ledger>) =>
	Effect.gen(function* () {
		const snapshot = yield* history.snapshot({ consistency: { kind: "latest" } })
		const command = yield* Command.seal({
			scope: history.identity,
			id: { receiptEpoch: history.receiptEpoch, requestId: Result.getOrThrow(RequestId.from(yield* mintId)) },
			precondition: { kind: "exact-state", at: snapshot.stateStamp },
			changes,
			result: {}
		})
		const outcome = yield* history.submit(command, { attempts: 2, backoff: { baseMillis: 1, capMillis: 10 } })
		assert.equal(outcome.kind, "decided")
		if (outcome.kind !== "decided") throw new Error("Native test did not reach a durable decision")
		return outcome.receipt
	})

export const yearFacts = (draft: Draft, year: number) =>
	Effect.gen(function* () {
		const release = yield* mintId,
			calendar = yield* mintId
		const evidence = "Synthetic Gregorian year qualification"
		yield* draft.insert(S.PolicyRelease, [
			{ id: release, title: evidence, sha256: `synthetic-${release}`, evidence, recordedAt: 0n }
		])
		yield* draft.insert(S.CalendarCoverage, [
			{ release, authority: "FederalDC", kind: "Year", span: periodSpan(year, "Year") }
		])
		yield* draft.insert(S.CalendarPeriod, [
			{
				id: calendar,
				release,
				authority: "FederalDC",
				kind: "Year",
				span: periodSpan(year, "Year"),
				year: BigInt(year),
				ordinal: 1n
			}
		])
		return calendar
	})

export const atTime = <A, E, R>(instant: number, program: Effect.Effect<A, E, R>) =>
	Effect.gen(function* () {
		const real = yield* Clock.Clock
		const clock: Clock.Clock = {
			currentTimeMillisUnsafe: () => instant,
			currentTimeMillis: Effect.succeed(instant),
			currentTimeNanosUnsafe: () => BigInt(instant) * 1000000n,
			currentTimeNanos: Effect.succeed(BigInt(instant) * 1000000n),
			monotonicTimeNanosUnsafe: () => real.monotonicTimeNanosUnsafe(),
			monotonicTimeNanos: real.monotonicTimeNanos,
			sleep: (duration) => real.sleep(duration)
		}
		return yield* program.pipe(Effect.provideService(Clock.Clock, clock))
	})

export const bankForWage = (
	draft: Draft,
	wage: import("@bjornpagen/bumbledb").Uuid,
	business: import("@bjornpagen/bumbledb").Uuid,
	day: bigint,
	amount: bigint
) =>
	Effect.gen(function* () {
		const movement = yield* mintId
		yield* draft.insert(S.BankMovement, [
			{
				id: movement,
				business,
				direction: "Outflow",
				paidOn: day,
				amount,
				evidence: "Synthetic Mercury payment",
				recordedAt: 0n
			}
		])
		yield* draft.insert(S.MercuryTransaction, [{ movement, reference: `synthetic-${movement}` }])
		yield* draft.insert(S.PayrollTransaction, [{ wage, movement, business }])
		return movement
	})
