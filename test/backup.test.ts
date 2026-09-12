import assert from "node:assert/strict"
import * as path from "node:path"
import { test } from "node:test"
import { ChangeSet, query, v } from "@bjornpagen/bumbledb"
import {
	backup,
	IncarnationId,
	LocalHistory,
	OperationId,
	restore,
	verifyBackup
} from "@bjornpagen/bumbledb-log"
import { Effect, Result } from "effect"
import { json, mintId, Refusal } from "../src/core/values.ts"
import { rows } from "../src/queries.ts"
import * as S from "../src/schema.ts"
import { apply, withHistory } from "./native-history.ts"

const businesses = query(S.ledger).rule((r) => {
	const row = v(S.Business)
	return r.match(S.Business, row).find(row)
})

test("native backup restores the Wagie Tools theory and facts into a new writable incarnation", async () => {
	await withHistory((history, binding, directory) =>
		Effect.gen(function* () {
			const draft = yield* ChangeSet.builder(S.ledger)
			const business = {
				id: yield* mintId,
				name: "Backup Test",
				ein: "00-0000003",
				state: "TX",
				timeZone: "America/Chicago",
				recordedAt: 1234567890000n
			} as const
			yield* draft.insert(S.Business, [business])
			assert.equal((yield* apply(history, yield* draft.finish())).outcome.kind, "committed")
			const destination = { kind: "filesystem", directory: path.join(directory, "backup") } as const
			const operationId = Result.getOrThrow(OperationId.from(yield* mintId))
			const backed = yield* backup(binding, { operationId, destination, schema: S.ledger })
			assert.equal(backed.kind, "completed", json(backed))
			const verified = yield* verifyBackup(destination, { backup: operationId })
			assert.deepEqual(verified.identity, history.identity)
			const restored = yield* restore(
				destination,
				{
					...binding,
					directory: path.join(directory, "restored"),
					identity: {
						...binding.identity,
						incarnationId: Result.getOrThrow(IncarnationId.from(yield* mintId))
					}
				},
				{
					operationId: Result.getOrThrow(OperationId.from(yield* mintId)),
					backup: operationId,
					schema: S.ledger
				}
			)
			assert.equal(restored.kind, "completed", json(restored))
			if (restored.kind !== "completed") throw new Error("Native restore did not complete")
			assert.notEqual(restored.value.identity.incarnationId, history.identity.incarnationId)
			const target = restored.value.binding
			assert.equal(target.kind, "local")
			if (target.kind !== "local") throw new Error("Local restore returned a different binding kind")
			const restoredHistory = yield* LocalHistory.open(target, S.ledger)
			const snapshot = yield* restoredHistory.snapshot({ consistency: { kind: "latest" } })
			assert.deepEqual(yield* rows(snapshot, businesses, {}), [business])
			const subsequent = yield* ChangeSet.builder(S.ledger)
			yield* subsequent.insert(S.BusinessAddress, [
				{
					business: business.id,
					kind: "Mailing",
					street: "Synthetic",
					city: "Synthetic",
					state: "TX",
					zip: "00000",
					country: "US"
				}
			])
			assert.equal((yield* apply(restoredHistory, yield* subsequent.finish())).outcome.kind, "committed")
		})
	)
})

test("application backups preserve prior-incarnation command evidence without resolving it against a migrated authority", async () => {
	const { backupLedger, verifyArchive } = await import("../src/backup.ts")
	const { configureBusiness } = await import("../src/profiles.ts")
	const { Ledger } = await import("../src/runtime.ts")
	const fs = await import("node:fs/promises")
	await withHistory((history, binding, directory) =>
		Effect.gen(function* () {
			const recoveryDirectory = path.join(directory, "requests")
			const oldRequest = yield* mintId
			yield* configureBusiness({
				request: oldRequest,
				name: "Synthetic migration backup",
				ein: "00-0000019",
				state: "TX",
				timeZone: "America/Chicago",
				addresses: [],
				evidence: "Synthetic identity lifecycle"
			}).pipe(Effect.provideService(Ledger, { history, binding, recoveryDirectory }))
			const originalEnvelope = yield* Effect.promise(() =>
				fs.readFile(path.join(recoveryDirectory, `${oldRequest}.json`))
			)
			const destination = { kind: "filesystem", directory: path.join(directory, "native-backup") } as const
			const operationId = Result.getOrThrow(OperationId.from(yield* mintId))
			assert.equal((yield* backup(binding, { operationId, destination, schema: S.ledger })).kind, "completed")
			const restored = yield* restore(
				destination,
				{
					...binding,
					directory: path.join(directory, "new-authority"),
					identity: {
						...binding.identity,
						incarnationId: Result.getOrThrow(IncarnationId.from(yield* mintId))
					}
				},
				{
					operationId: Result.getOrThrow(OperationId.from(yield* mintId)),
					backup: operationId,
					schema: S.ledger
				}
			)
			assert.equal(restored.kind, "completed")
			if (restored.kind !== "completed" || restored.value.binding.kind !== "local")
				throw new Error("Native restore failed")
			const currentBinding = restored.value.binding
			const current = yield* LocalHistory.open(currentBinding, S.ledger)
			const { Command, renderCommandRef, RequestId } = yield* Effect.promise(
				() => import("@bjornpagen/bumbledb-log")
			)
			const pendingRequest = yield* mintId
			const empty = yield* ChangeSet.builder(S.ledger)
			const pending = yield* Command.seal({
				scope: current.identity,
				id: {
					receiptEpoch: current.receiptEpoch,
					requestId: Result.getOrThrow(RequestId.from(pendingRequest))
				},
				precondition: {
					kind: "exact-state",
					at: (yield* current.snapshot({ consistency: { kind: "latest" } })).stateStamp
				},
				changes: yield* empty.finish(),
				result: {}
			})
			const bytes = yield* Command.encode(pending)
			yield* Effect.promise(() =>
				fs.writeFile(
					path.join(recoveryDirectory, `${pendingRequest}.json`),
					json({
						requestId: pendingRequest,
						action: "Synthetic pending request",
						inputHash: "synthetic",
						recordingDay: "0",
						timeZone: "UTC",
						commandRef: renderCommandRef(pending.ref),
						commandBytes: Buffer.from(bytes).toString("base64")
					})
				)
			)
			const refused = yield* Effect.result(
				backupLedger({
					operation: yield* mintId,
					output: path.join(directory, "pending-must-refuse.tar.gz")
				}).pipe(
					Effect.provideService(Ledger, { history: current, binding: currentBinding, recoveryDirectory })
				)
			)
			assert.ok(Result.isFailure(refused))
			assert.ok(refused.failure instanceof Refusal)
			assert.equal(refused.failure.code, "UnresolvedCommands")
			assert.equal(
				(yield* current.submit(pending, { attempts: 2, backoff: { baseMillis: 1, capMillis: 10 } })).kind,
				"decided"
			)
			const captured = yield* backupLedger({
				operation: yield* mintId,
				output: path.join(directory, "current.tar.gz")
			}).pipe(Effect.provideService(Ledger, { history: current, binding: currentBinding, recoveryDirectory }))
			const verified = yield* verifyArchive(captured.archive)
			assert.equal(verified.audit.factsDigest, captured.factsDigest)
			assert.deepEqual(
				yield* Effect.promise(() => fs.readFile(path.join(recoveryDirectory, `${oldRequest}.json`))),
				originalEnvelope
			)
		})
	)
})
