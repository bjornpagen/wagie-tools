import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { test } from "node:test"
import { pathToFileURL } from "node:url"
import { ChangeSet, query, v } from "@bjornpagen/bumbledb"
import { Effect } from "effect"
import { io } from "../src/core/files.ts"
import { mintId } from "../src/core/values.ts"
import { locateArtifact, recordArtifact, recordMailing, verifyArtifact } from "../src/evidence.ts"
import { rows } from "../src/queries.ts"
import { Ledger } from "../src/runtime.ts"
import * as S from "../src/schema.ts"
import { apply, withHistory } from "./native-history.ts"

const artifacts = query(S.ledger).rule((r) => {
	const row = v(S.Artifact)
	return r.match(S.Artifact, row).find(row)
})
const locations = query(S.ledger).rule((r) => {
	const row = v(S.ArtifactLocation)
	return r.match(S.ArtifactLocation, row).find(row)
})
const mailings = query(S.ledger).rule((r) => {
	const row = v(S.CertifiedMailing)
	return r.match(S.CertifiedMailing, row).find(row)
})

test("document identities survive moves; changed bytes refuse, and repeated certified evidence describes one packet", async () => {
	await withHistory((history, binding, directory) =>
		Effect.gen(function* () {
			const business = yield* mintId,
				evidence = "Synthetic evidence qualification"
			const seed = yield* ChangeSet.builder(S.ledger)
			yield* seed.insert(S.Business, [
				{ id: business, name: "Synthetic", ein: "00-0000086", state: "TX", timeZone: "UTC", recordedAt: 0n }
			])
			assert.equal((yield* apply(history, yield* seed.finish())).outcome.kind, "committed")
			const firstFile = path.join(directory, "receipt #1.txt"),
				movedFile = path.join(directory, "moved receipt.txt")
			yield* io("write synthetic evidence", () => fs.writeFile(firstFile, "synthetic immutable bytes"))
			yield* recordArtifact({
				request: yield* mintId,
				business,
				file: firstFile,
				mediaType: "text/plain",
				evidence
			})
			let snapshot = yield* history.snapshot({ consistency: { kind: "latest" } })
			const artifact = (yield* rows(snapshot, artifacts, {}))[0]
			assert.ok(artifact)
			assert.equal((yield* rows(snapshot, locations, {}))[0]?.locator, pathToFileURL(firstFile).href)
			yield* io("move synthetic evidence", () => fs.rename(firstFile, movedFile))
			yield* recordArtifact({
				request: yield* mintId,
				business,
				file: movedFile,
				mediaType: "text/plain",
				evidence
			})
			yield* locateArtifact({
				request: yield* mintId,
				business,
				artifact: artifact.id,
				locator: "gdrive-file:SYNTHETIC",
				evidence
			})
			yield* verifyArtifact({
				request: yield* mintId,
				business,
				artifact: artifact.id,
				file: movedFile,
				evidence
			})
			snapshot = yield* history.snapshot({ consistency: { kind: "latest" } })
			assert.equal((yield* rows(snapshot, artifacts, {})).length, 1)
			assert.equal((yield* rows(snapshot, locations, {})).length, 3)
			yield* io("change synthetic evidence", () => fs.writeFile(movedFile, "different document"))
			assert.equal(
				(yield* Effect.result(
					verifyArtifact({
						request: yield* mintId,
						business,
						artifact: artifact.id,
						file: movedFile,
						evidence
					})
				))._tag,
				"Failure"
			)
			assert.deepEqual(
				(yield* history.snapshot({ consistency: { kind: "latest" } })).stateStamp,
				snapshot.stateStamp
			)
			yield* recordArtifact({
				request: yield* mintId,
				business,
				file: movedFile,
				mediaType: "text/plain",
				evidence
			})
			snapshot = yield* history.snapshot({ consistency: { kind: "latest" } })
			assert.equal((yield* rows(snapshot, artifacts, {})).length, 2)
			const input = {
				request: yield* mintId,
				business,
				carrier: "USPS",
				number: "0000 1234 5678 9012 3456 78",
				mailedOn: "2026-09-10",
				receipt: artifact.id,
				evidence,
				artifacts: []
			}
			yield* recordMailing(input)
			yield* recordMailing({ ...input, request: yield* mintId, number: "0000123456789012345678" })
			snapshot = yield* history.snapshot({ consistency: { kind: "latest" } })
			const packets = yield* rows(snapshot, mailings, {})
			assert.equal(packets.length, 1)
			assert.equal(packets[0]?.number, "0000123456789012345678")
			assert.equal(
				(yield* Effect.result(recordMailing({ ...input, request: yield* mintId, mailedOn: "2026-09-11" })))
					._tag,
				"Failure"
			)
			assert.equal(
				(yield* Effect.exit(recordMailing({ ...input, request: yield* mintId, number: "  " })))._tag,
				"Failure"
			)
			assert.deepEqual(
				(yield* history.snapshot({ consistency: { kind: "latest" } })).stateStamp,
				snapshot.stateStamp
			)
		}).pipe(
			Effect.provideService(Ledger, { history, binding, recoveryDirectory: path.join(directory, "requests") })
		)
	)
})
