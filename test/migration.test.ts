import assert from "node:assert/strict"
import { test } from "node:test"
import { ChangeSet, Schema } from "@bjornpagen/bumbledb"
import { IncarnationId, LocalHistory, OperationId, Transition } from "@bjornpagen/bumbledb-log"
import { Effect, Result } from "effect"
import { populateInitial } from "../migrations/0000-initial/cutover.ts"
import { schema } from "../migrations/0000-initial/schema.ts"
import { inventory } from "../src/audit.ts"
import { mintId } from "../src/core/values.ts"
import * as S from "../src/schema.ts"
import { apply, withHistory } from "./native-history.ts"

test("initial cutover preserves every fact, keeps source receipts, and resolves activation after target writes", async () => {
	await withHistory((history, binding) =>
		Effect.gen(function* () {
			assert.equal((yield* Schema.compile(schema)).schemaId, binding.identity.schemaId)
			const business = yield* mintId
			const draft = yield* ChangeSet.builder(S.ledger)
			yield* draft.insert(S.Business, [
				{
					id: business,
					name: "Synthetic baseline",
					ein: "00-0000091",
					state: "TX",
					timeZone: "UTC",
					recordedAt: 0n
				}
			])
			const receipt = yield* apply(history, yield* draft.finish())
			const before = yield* inventory(yield* history.snapshot({ consistency: { kind: "latest" } }))
			yield* history.close()
			const source = yield* LocalHistory.open(binding, schema)
			const contract = {
				operation: Result.getOrThrow(OperationId.from(yield* mintId)),
				source: binding.identity,
				target: { ...binding.identity, incarnationId: Result.getOrThrow(IncarnationId.from(yield* mintId)) },
				commitment: "ab".repeat(32)
			}
			const start = yield* Transition.begin(source, schema, contract)
			assert.equal(start.kind, "populating")
			if (start.kind !== "populating") throw new Error("Expected a new population")
			yield* populateInitial(start.source, start.population)
			const ready = yield* start.population.finish()
			assert.deepEqual(yield* Transition.resolve(source, schema, contract), ready)
			yield* Effect.scoped(
				Effect.gen(function* () {
					const target = yield* LocalHistory.open(ready.binding, S.ledger)
					assert.deepEqual(yield* inventory(yield* Transition.inspect(target, ready.installed)), before)
				})
			)
			const activated = yield* Transition.activate(source, schema, ready.installed)
			const target = yield* LocalHistory.open(activated.binding, S.ledger)
			const next = yield* ChangeSet.builder(S.ledger)
			yield* next.insert(S.BusinessAddress, [
				{
					business,
					kind: "Mailing",
					street: "Synthetic",
					city: "Synthetic",
					state: "TX",
					zip: "00000",
					country: "US"
				}
			])
			assert.equal((yield* apply(target, yield* next.finish())).outcome.kind, "committed")
			assert.deepEqual(yield* Transition.begin(source, schema, contract), activated)
			assert.deepEqual(yield* Transition.resolve(source, schema, contract), activated)
			const original = yield* source.resolve(receipt.command)
			assert.equal(original.kind, "found")
			if (original.kind === "found") assert.deepEqual(original.receipt, receipt)
		})
	)
})
