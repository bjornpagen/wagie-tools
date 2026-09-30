import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { test } from "node:test"
import { ChangeSet } from "@bjornpagen/bumbledb"
import { Effect } from "effect"
import { io } from "../src/core/files.ts"
import { mintId } from "../src/core/values.ts"
import { archiveArtifact, collectDocuments, inspectDocuments } from "../src/documents.ts"
import { locateArtifact, recordArtifact, verifyArtifact } from "../src/evidence.ts"
import { Ledger } from "../src/runtime.ts"
import * as S from "../src/schema.ts"
import { apply, withHistory } from "./native-history.ts"

test("Drive archival refuses wrong bytes, preserves identity, survives loss of local files and detects remote replacement", async () => {
	await withHistory((history, binding, directory) =>
		Effect.gen(function* () {
			const business = yield* mintId
			const seed = yield* ChangeSet.builder(S.ledger)
			yield* seed.insert(S.Business, [
				{ id: business, name: "Synthetic", ein: "00-0000087", state: "TX", timeZone: "UTC" }
			])
			yield* apply(history, yield* seed.finish())
			const file = path.join(directory, "receipt.txt"),
				bytes = Buffer.from("original receipt")
			yield* io("write fixture", () => fs.writeFile(file, bytes))
			yield* recordArtifact({
				request: yield* mintId,
				business,
				file,
				mediaType: "text/plain",
				evidence: "synthetic"
			})
			const snapshot = yield* history.snapshot({ consistency: { kind: "latest" } })
			const document = (yield* inspectDocuments(snapshot))[0]
			assert.ok(document)
			assert.equal((yield* Effect.result(collectDocuments(snapshot, "fixture:", undefined)))._tag, "Failure")
			const input = {
				request: yield* mintId,
				business,
				artifact: document.id,
				driveFileId: "synthetic_file_123",
				remote: "fixture:",
				evidence: "synthetic archive"
			}
			assert.equal(
				(yield* Effect.result(archiveArtifact(input, () => Effect.succeed(Buffer.from("wrong")))))._tag,
				"Failure"
			)
			assert.deepEqual(
				(yield* history.snapshot({ consistency: { kind: "latest" } })).stateStamp,
				snapshot.stateStamp
			)
			const accepted = { ...input, request: yield* mintId }
			yield* archiveArtifact(accepted, () => Effect.succeed(bytes))
			// Retrying a committed request needs neither its local file nor a working provider.
			yield* archiveArtifact(accepted, () => {
				throw new Error("must not download on retry")
			})
			yield* verifyArtifact({
				request: yield* mintId,
				business,
				artifact: document.id,
				file,
				evidence: "local cache check"
			})
			assert.equal(
				(yield* Effect.result(
					locateArtifact({
						request: yield* mintId,
						business,
						artifact: document.id,
						locator: "file:///old/path",
						evidence: "synthetic"
					})
				))._tag,
				"Failure"
			)
			yield* io("remove original fixture", () => fs.unlink(file))
			const archived = yield* history.snapshot({ consistency: { kind: "latest" } })
			assert.equal((yield* inspectDocuments(archived))[0]?.archived, true)
			const recovered = yield* collectDocuments(archived, "fixture:", undefined, () => Effect.succeed(bytes))
			assert.equal(recovered[0]?.artifact, document.id)
			assert.deepEqual(recovered[0]?.bytes, bytes)
			assert.equal(
				(yield* Effect.result(
					collectDocuments(archived, "fixture:", undefined, () => Effect.succeed(Buffer.from("replaced")))
				))._tag,
				"Failure"
			)
		}).pipe(
			Effect.provideService(Ledger, { history, binding, recoveryDirectory: path.join(directory, "requests") })
		)
	)
})
