import assert from "node:assert/strict"
import * as path from "node:path"
import { test } from "node:test"
import { ChangeSet, query, v } from "@bjornpagen/bumbledb"
import { Command, RequestId, renderCommandRef } from "@bjornpagen/bumbledb-log"
import { Deferred, Effect, Result } from "effect"
import { privateDirectory, retain } from "../src/core/files.ts"
import { epochDay, today } from "../src/core/time.ts"
import { json, mintId } from "../src/core/values.ts"
import { rows } from "../src/queries.ts"
import {
	commit,
	createHistory,
	fingerprint,
	Ledger,
	planAndCommit,
	previousRequest,
	resolveRequest
} from "../src/runtime.ts"
import * as S from "../src/schema.ts"
import { refusalCode as refusal } from "./assertions.ts"
import { withHistory } from "./native-history.ts"

const businesses = query(S.ledger).rule((r) => {
	const row = v(S.Business)
	return r.match(S.Business, row).find(row)
})

test("two planners using one request dispatch only the atomically retained winner", async () => {
	await withHistory((history, binding, directory) =>
		Effect.gen(function* () {
			const request = yield* mintId
			const recordingDay = yield* today("UTC")
			const bothPlanned = yield* Deferred.make<void>()
			let planned = 0
			const run = planAndCommit({
				request,
				action: "business record",
				input: { name: "Concurrent" },
				recordingDay,
				timeZone: "UTC",
				plan: (_snapshot, draft) =>
					Effect.gen(function* () {
						const business = yield* mintId
						yield* draft.insert(S.Business, [
							{
								id: business,
								name: "Concurrent",
								ein: "00-0000088",
								state: "TX",
								timeZone: "UTC",
								recordedAt: 0n
							}
						])
						planned++
						if (planned === 2) yield* Deferred.succeed(bothPlanned, undefined)
						yield* Deferred.await(bothPlanned)
						return { business }
					})
			})
			const [a, b] = yield* Effect.all([run, run], { concurrency: 2 })
			assert.equal(planned, 2, "both proposals were built before exclusive publication")
			assert.deepEqual(a, b, "both callers resolve the same native receipt and minted entity")
			const snapshot = yield* history.snapshot({ consistency: { kind: "latest" } })
			assert.equal((yield* rows(snapshot, businesses, {})).length, 1)
		}).pipe(
			Effect.provideService(Ledger, { history, binding, recoveryDirectory: path.join(directory, "requests") })
		)
	)
})

test("retained commands preserve identities across retries and refuse stale state or recording date", async () => {
	await withHistory((history, binding, directory) =>
		Effect.gen(function* () {
			const recordingDay = yield* today("UTC")
			const recoveryDirectory = path.join(directory, "requests")
			const request = yield* mintId
			let planned = 0
			const original = planAndCommit({
				request,
				action: "business record",
				input: { name: "First" },
				recordingDay,
				timeZone: "UTC",
				plan: (_snapshot, draft) =>
					Effect.gen(function* () {
						planned++
						const business = yield* mintId
						yield* draft.insert(S.Business, [
							{ id: business, name: "First", ein: "00-0000011", state: "TX", timeZone: "UTC", recordedAt: 0n }
						])
						return { business }
					})
			})
			const first = yield* original
			const again = yield* original
			assert.deepEqual(again, first)
			assert.equal(planned, 1, "retries resolve before reminting entity identities")
			const other = yield* createHistory(path.join(directory, "other-incarnation"))
			const otherLedger = { ...other, recoveryDirectory }
			assert.equal(
				refusal(yield* Effect.result(original.pipe(Effect.provideService(Ledger, otherLedger)))),
				"RequestHistoryChanged"
			)
			assert.equal(
				refusal(
					yield* Effect.result(resolveRequest(request).pipe(Effect.provideService(Ledger, otherLedger)))
				),
				"RequestHistoryChanged"
			)
			assert.equal(planned, 1, "a foreign retained command never starts fresh planning")
			assert.equal(
				(yield* rows(yield* other.history.snapshot({ consistency: { kind: "latest" } }), businesses, {}))
					.length,
				0
			)
			assert.equal(
				refusal(yield* Effect.result(previousRequest(request, "business record", { name: "Different" }))),
				"RequestReused"
			)

			const interruptedRequest = yield* mintId
			const secondBusiness = yield* mintId
			const draft = yield* ChangeSet.builder(S.ledger)
			yield* draft.insert(S.Business, [
				{
					id: secondBusiness,
					name: "Recovered",
					ein: "00-0000012",
					state: "TX",
					timeZone: "UTC",
					recordedAt: 0n
				}
			])
			const command = yield* Command.seal({
				scope: history.identity,
				id: {
					receiptEpoch: history.receiptEpoch,
					requestId: Result.getOrThrow(RequestId.from(interruptedRequest))
				},
				precondition: { kind: "exact-state", at: first.stateAt },
				changes: yield* draft.finish(),
				result: { business: secondBusiness }
			})
			yield* privateDirectory(recoveryDirectory)
			yield* retain(
				path.join(recoveryDirectory, `${interruptedRequest}.json`),
				json({
					requestId: interruptedRequest,
					action: "business record",
					inputHash: fingerprint({ name: "Recovered" }),
					recordingDay,
					timeZone: "UTC",
					commandRef: renderCommandRef(command.ref),
					commandBytes: Buffer.from(yield* Command.encode(command)).toString("base64")
				})
			)
			// Simulate process loss after durable retention, before dispatch.
			const recovered = yield* previousRequest(interruptedRequest, "business record", { name: "Recovered" })
			assert.ok(recovered)
			assert.deepEqual(recovered.command, command.ref)
			const after = yield* history.snapshot({ consistency: { kind: "latest" } })
			assert.equal((yield* rows(after, businesses, {})).length, 2)
			assert.deepEqual(
				yield* previousRequest(interruptedRequest, "business record", { name: "Recovered" }),
				recovered
			)

			const stale = yield* ChangeSet.builder(S.ledger)
			yield* stale.insert(S.BusinessAddress, [
				{
					business: secondBusiness,
					kind: "Mailing",
					street: "Synthetic",
					city: "Synthetic",
					state: "TX",
					zip: "00000",
					country: "US"
				}
			])
			const refused = yield* Effect.result(
				commit({
					request: yield* mintId,
					action: "business address",
					input: {},
					recordingDay,
					timeZone: "UTC",
					at: first.stateAt,
					changes: yield* stale.finish(),
					result: {}
				})
			)
			assert.equal(refusal(refused), "precondition-failed")
			assert.deepEqual(
				(yield* history.snapshot({ consistency: { kind: "latest" } })).stateStamp,
				after.stateStamp
			)
			const next = yield* ChangeSet.builder(S.ledger)
			const expired = yield* Effect.result(
				commit({
					request: yield* mintId,
					action: "business record",
					input: {},
					recordingDay: epochDay(recordingDay - 1n),
					timeZone: "UTC",
					at: after.stateStamp,
					changes: yield* next.finish(),
					result: {}
				})
			)
			assert.equal(refusal(expired), "RecordingDayChanged")
		}).pipe(
			Effect.provideService(Ledger, { history, binding, recoveryDirectory: path.join(directory, "requests") })
		)
	)
})
