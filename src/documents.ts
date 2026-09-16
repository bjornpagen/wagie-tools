import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { promisify } from "node:util"
import { Effect, Schema } from "effect"
import { businessCommand } from "./commands.ts"
import { io } from "./core/files.ts"
import { json, mintId, Nonblank, Refusal } from "./core/values.ts"
import { relationRows } from "./queries.ts"
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

const ArchiveInput = Schema.Struct({
	...commandFields,
	artifact: Id,
	driveFileId: Nonblank,
	remote: Nonblank,
	evidence: Nonblank
})
type Download = typeof downloadDriveFile

/** Replace active locations only after independently retrieving matching bytes.
 * Prior locations and their evidence remain in the immutable command history
 * and in the new location's provenance; the artifact identity never changes.
 */
export const archiveArtifact = (payload: unknown, download: Download = downloadDriveFile) =>
	Effect.gen(function* () {
		const input = parseStrict(ArchiveInput, payload)
		const locator = driveLocator(input.driveFileId)
		return yield* businessCommand({
			request: input.request,
			business: input.business,
			action: "artifact archive",
			input: payload,
			plan: ({ snapshot, draft, recordedAt }) =>
				Effect.gen(function* () {
					const artifact = (yield* relationRows(snapshot, S.Artifact)).find((r) => r.id === input.artifact)
					if (!artifact)
						return yield* Effect.fail(
							new Refusal({ code: "ArtifactMissing", message: "Select a registered artifact" })
						)
					const bytes = yield* download(input.driveFileId, input.remote)
					if (sha256(bytes) !== artifact.sha256)
						return yield* Effect.fail(
							new Refusal({
								code: "ArtifactChanged",
								message: "Drive bytes do not match the registered SHA-256"
							})
						)
					const previous = (yield* relationRows(snapshot, S.ArtifactLocation)).filter(
						(r) => r.artifact === artifact.id
					)
					const verified = (yield* relationRows(snapshot, S.VerifiedArtifact)).filter(
						(r) => r.artifact === artifact.id
					)
					yield* draft.delete(S.ArtifactLocation, previous)
					yield* draft.delete(S.VerifiedArtifact, verified)
					yield* draft.insert(S.VerifiedArtifact, [
						{ artifact: artifact.id, length: BigInt(bytes.length), verifiedAt: recordedAt }
					])
					yield* draft.insert(S.ArtifactLocation, [
						{
							artifact: artifact.id,
							locator,
							evidence: json({
								kind: "VerifiedDriveArtifact",
								remote: input.remote,
								sha256: artifact.sha256,
								length: String(bytes.length),
								verifiedAt: String(recordedAt),
								evidence: input.evidence,
								previousLocations: previous
							})
						}
					])
					return { artifact: artifact.id, locator, sha256: artifact.sha256, length: String(bytes.length) }
				})
		})
	})

export const inspectDocuments = (snapshot: Snapshot) =>
	Effect.gen(function* () {
		const artifacts = yield* relationRows(snapshot, S.Artifact)
		const locations = yield* relationRows(snapshot, S.ArtifactLocation)
		return artifacts.map((artifact) => {
			const refs = locations.filter((r) => r.artifact === artifact.id)
			const archived =
				refs.length === 1 &&
				refs.every((r) => {
					try {
						const proof = JSON.parse(r.evidence)
						return (
							!!driveId(r.locator) &&
							proof.kind === "VerifiedDriveArtifact" &&
							proof.sha256 === artifact.sha256
						)
					} catch {
						return false
					}
				})
			return { ...artifact, locations: refs, archived }
		})
	})

/** Returns the verified bytes so backup capture cannot race a second download. */
export const collectDriveDocuments = (
	snapshot: Snapshot,
	remote: string,
	download: Download = downloadDriveFile
) =>
	Effect.gen(function* () {
		const documents = yield* inspectDocuments(snapshot)
		const missing = documents.filter((d) => !d.archived || !/^[a-f0-9]{64}$/.test(d.sha256))
		if (missing.length)
			return yield* Effect.fail(
				new Refusal({
					code: "DocumentsUnarchived",
					message: `${missing.length} documents lack a verified canonical Drive location: ${missing.map((d) => d.id).join(", ")}`
				})
			)
		return yield* Effect.forEach(
			documents,
			(document) =>
				Effect.gen(function* () {
					const id = driveId(document.locations[0]?.locator ?? "")
					if (!id)
						return yield* Effect.fail(
							new Refusal({ code: "DriveIdentity", message: "Missing Drive identity" })
						)
					const bytes = yield* download(id, remote)
					if (sha256(bytes) !== document.sha256)
						return yield* Effect.fail(
							new Refusal({ code: "ArtifactChanged", message: `Drive content changed for ${document.id}` })
						)
					return { artifact: document.id, sha256: document.sha256, locator: driveLocator(id), bytes }
				}),
			{ concurrency: 4 }
		)
	})

/** A typed receipt association, without creating another bank movement. */
export const attachBankArtifact = (payload: unknown) =>
	Effect.gen(function* () {
		const input = parseStrict(
			Schema.Struct({ ...commandFields, artifact: Id, movement: Id, evidence: Nonblank }),
			payload
		)
		return yield* businessCommand({
			request: input.request,
			business: input.business,
			action: "artifact attach-bank",
			input: payload,
			plan: ({ snapshot, draft, recordedAt }) =>
				Effect.gen(function* () {
					const bank = (yield* relationRows(snapshot, S.BankMovement)).find(
						(r) => r.id === input.movement && r.business === input.business
					)
					const artifact = (yield* relationRows(snapshot, S.Artifact)).find((r) => r.id === input.artifact)
					if (!bank || !artifact)
						return yield* Effect.fail(
							new Refusal({
								code: "ArtifactScope",
								message: "Select an existing business movement and artifact"
							})
						)
					const existing = (yield* relationRows(snapshot, S.BankObservation)).find(
						(r) => r.artifact === artifact.id && r.row === 1n
					)
					const linked = (yield* relationRows(snapshot, S.BankSource)).find(
						(r) => r.observation === existing?.id
					)
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
							source: input.evidence,
							recordedAt
						}
					])
					yield* draft.insert(S.BankSource, [{ movement: bank.id, observation, business: bank.business }])
					return { movement: bank.id, artifact: artifact.id, observation }
				})
		})
	})
