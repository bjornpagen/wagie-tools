import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { promisify } from "node:util"
import { Effect, Schema } from "effect"
import { businessCommand } from "./commands.ts"
import { io } from "./core/files.ts"
import { mintId, Nonblank, Refusal } from "./core/values.ts"
import { exists, first, relationRows, select } from "./queries.ts"
import { parseStrict, type Snapshot } from "./runtime.ts"
import { commandFields, Id } from "./schema/input.ts"
import * as S from "./schema.ts"

const exec = promisify(execFile)
export const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
export const driveLocator = (id: string) => {
	if (!/^[A-Za-z0-9_-]{10,200}$/.test(id))
		throw new Refusal({ code: "DriveIdentity", message: "Supply a Google Drive file ID" })
	return `https://drive.google.com/file/d/${id}/view`
}
export const driveId = (locator: string) =>
	/^https:\/\/drive\.google\.com\/file\/d\/([A-Za-z0-9_-]{10,200})\/view$/.exec(locator)?.[1]

/** Fetch by identity, never by a machine path or mutable Drive filename. */
export const downloadDriveFile = (id: string, remote = "gdrive:") =>
	io("download Drive evidence by file ID", async () => {
		driveLocator(id)
		if (!/^[A-Za-z0-9_-]+:$/.test(remote)) throw new Error("Select a configured rclone Drive remote")
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "wagie-document-"))
		try {
			const file = path.join(directory, "document")
			await exec("rclone", ["backend", "copyid", remote, id, file], { timeout: 120000 })
			return await fs.readFile(file)
		} finally {
			await fs.rm(directory, { recursive: true, force: true })
		}
	})

export const StoragePolicy = Schema.Struct({
	version: Schema.Literal(1),
	required: Schema.Literal("GoogleDrive"),
	remote: Nonblank
})
export const loadStoragePolicy = (directory: string) =>
	io("read document storage policy", async () => {
		try {
			return parseStrict(
				StoragePolicy,
				JSON.parse(await fs.readFile(path.join(directory, "storage.json"), "utf8"))
			)
		} catch (error) {
			if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined
			throw error
		}
	})

export const ArchiveInput = Schema.Struct({
	...commandFields,
	artifact: Id,
	driveFileId: Nonblank,
	remote: Nonblank,
	evidence: Nonblank
})
type Download = typeof downloadDriveFile

/** Adopt a verified Drive copy only after independently retrieving matching
 * bytes. Active locations become prior locations of that copy; the artifact
 * identity never changes. The copy's UUIDv7 is the verification instant.
 */
export const archiveArtifact = (payload: unknown, download: Download = downloadDriveFile) =>
	Effect.gen(function* () {
		const input = parseStrict(ArchiveInput, payload)
		driveLocator(input.driveFileId)
		return yield* businessCommand({
			request: input.request,
			business: input.business,
			action: "artifact archive",
			input: payload,
			plan: ({ snapshot, draft, note }) =>
				Effect.gen(function* () {
					const artifact = yield* first(snapshot, S.Artifact, { id: input.artifact })
					if (!artifact)
						return yield* Effect.fail(
							new Refusal({ code: "ArtifactMissing", message: "Select a registered artifact" })
						)
					if (yield* exists(snapshot, S.DriveCopy, { artifact: artifact.id }))
						return yield* Effect.fail(
							new Refusal({ code: "ArtifactArchived", message: "This artifact already has its Drive copy" })
						)
					const bytes = yield* download(input.driveFileId, input.remote)
					if (sha256(bytes) !== artifact.sha256)
						return yield* Effect.fail(
							new Refusal({
								code: "ArtifactChanged",
								message: "Drive bytes do not match the registered SHA-256"
							})
						)
					const previous = yield* select(snapshot, S.ArtifactLocation, { artifact: artifact.id })
					const copy = yield* mintId
					yield* draft.delete(S.ArtifactLocation, previous)
					yield* draft.insert(S.DriveCopy, [
						{
							id: copy,
							artifact: artifact.id,
							driveId: input.driveFileId,
							remote: input.remote,
							evidence: yield* note(input.evidence)
						}
					])
					yield* draft.insert(
						S.PriorLocation,
						previous.map((r) => ({ copy, artifact: artifact.id, locator: r.locator, evidence: r.evidence }))
					)
					return { artifact: artifact.id, copy, driveId: input.driveFileId, sha256: artifact.sha256 }
				})
		})
	})

export const inspectDocuments = (snapshot: Snapshot) =>
	Effect.gen(function* () {
		const artifacts = yield* relationRows(snapshot, S.Artifact)
		const lengths = new Map(
			(yield* relationRows(snapshot, S.VerifiedArtifact)).map((r) => [r.artifact, r.length])
		)
		const locations = yield* relationRows(snapshot, S.ArtifactLocation)
		const copies = new Map((yield* relationRows(snapshot, S.DriveCopy)).map((r) => [r.artifact, r]))
		return artifacts.map((artifact) => {
			const copy = copies.get(artifact.id)
			return {
				...artifact,
				length: lengths.get(artifact.id),
				drive: copy
					? { copy: copy.id, driveId: copy.driveId, locator: driveLocator(copy.driveId) }
					: undefined,
				locations: locations.filter((r) => r.artifact === artifact.id),
				archived: copy !== undefined
			}
		})
	})

/** Every document's exact bytes, each checked against its registered SHA-256.
 * A verified local cache copy is used when present; otherwise the Drive copy
 * is downloaded by file ID. Returns the bytes so capture cannot race a second read.
 */
export const collectDocuments = (
	snapshot: Snapshot,
	remote: string,
	cacheDirectory: string | undefined,
	download: Download = downloadDriveFile
) =>
	Effect.gen(function* () {
		const documents = yield* inspectDocuments(snapshot)
		const missing = documents.filter((d) => !d.drive || !/^[a-f0-9]{64}$/.test(d.sha256))
		if (missing.length)
			return yield* Effect.fail(
				new Refusal({
					code: "DocumentsUnarchived",
					message: `${missing.length} documents lack a verified Drive copy: ${missing.map((d) => d.id).join(", ")}`
				})
			)
		return yield* Effect.forEach(
			documents,
			(document) =>
				Effect.gen(function* () {
					const drive = document.drive
					if (!drive)
						return yield* Effect.fail(new Refusal({ code: "DriveIdentity", message: "Missing Drive copy" }))
					const cached = cacheDirectory
						? yield* io("read cached document", async () => {
								try {
									return await fs.readFile(path.join(cacheDirectory, document.sha256))
								} catch {
									return undefined
								}
							})
						: undefined
					const bytes =
						cached && sha256(cached) === document.sha256 ? cached : yield* download(drive.driveId, remote)
					if (sha256(bytes) !== document.sha256)
						return yield* Effect.fail(
							new Refusal({ code: "ArtifactChanged", message: `Document bytes changed for ${document.id}` })
						)
					return { artifact: document.id, sha256: document.sha256, locator: drive.locator, bytes }
				}),
			{ concurrency: 4 }
		)
	})

export const AttachBankInput = Schema.Struct({
	...commandFields,
	artifact: Id,
	movement: Id,
	evidence: Nonblank
})

/** A typed receipt association, without creating another bank movement. */
export const attachBankArtifact = (payload: unknown) =>
	Effect.gen(function* () {
		const input = parseStrict(AttachBankInput, payload)
		return yield* businessCommand({
			request: input.request,
			business: input.business,
			action: "artifact attach-bank",
			input: payload,
			plan: ({ snapshot, draft, note }) =>
				Effect.gen(function* () {
					const bank = yield* first(snapshot, S.BankMovement, {
						id: input.movement,
						business: input.business
					})
					const artifact = yield* first(snapshot, S.Artifact, { id: input.artifact })
					if (!bank || !artifact)
						return yield* Effect.fail(
							new Refusal({
								code: "ArtifactScope",
								message: "Select an existing business movement and artifact"
							})
						)
					const existing = yield* first(snapshot, S.BankObservation, { artifact: artifact.id, row: 1n })
					const linked = existing && (yield* first(snapshot, S.BankSource, { observation: existing.id }))
					if (existing) {
						if (linked?.movement !== bank.id)
							return yield* Effect.fail(
								new Refusal({
									code: "ArtifactScope",
									message: "Receipt already describes a different movement"
								})
							)
						return { movement: bank.id, artifact: artifact.id, observation: existing.id }
					}
					const observation = yield* mintId
					yield* draft.insert(S.BankObservation, [
						{
							id: observation,
							business: bank.business,
							artifact: artifact.id,
							row: 1n,
							status: "Sent",
							observedOn: bank.paidOn,
							amount: bank.amount,
							evidence: yield* note(input.evidence)
						}
					])
					yield* draft.insert(S.BankSource, [{ movement: bank.id, observation, business: bank.business }])
					return { movement: bank.id, artifact: artifact.id, observation }
				})
		})
	})
