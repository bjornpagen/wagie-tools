import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import * as fs from "node:fs/promises"
import { createRequire } from "node:module"
import * as os from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import {
	backup,
	IncarnationId,
	LocalHistory,
	OperationId,
	restore,
	sameIdentity,
	verifyBackup
} from "@bjornpagen/bumbledb-log"
import { Effect, Result, Schema } from "effect"
import * as tar from "tar"
import { auditLedger } from "./audit.ts"
import { exists, io, privateDirectory, readBytes, readText, retainOnce } from "./core/files.ts"
import { epochDay, nowUnixMilliseconds, today } from "./core/time.ts"
import { EntityId, entityId, json, mintId, Refusal } from "./core/values.ts"
import {
	currentSchemaPath,
	Ledger,
	latest,
	loadStoredBinding,
	parseStrict,
	repositoryRoot,
	resolveRequest,
	retainedRequestReference
} from "./runtime.ts"
import ledger from "./schema.ts"

const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
const exec = promisify(execFile)
const runtimeEvidence = io("capture code and runtime provenance", async () => {
	const head = (await exec("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot })).stdout.trim()
	const changed = (await exec("git", ["status", "--porcelain"], { cwd: repositoryRoot })).stdout.length > 0
	const listed = (
		await exec(
			"git",
			[
				"ls-files",
				"-z",
				"--cached",
				"--others",
				"--exclude-standard",
				"--",
				"src",
				"scripts",
				"migrations",
				"package.json",
				"pnpm-lock.yaml",
				"pnpm-workspace.yaml",
				"tsconfig.json",
				"SKILL.md"
			],
			{ cwd: repositoryRoot }
		)
	).stdout
		.split("\0")
		.filter(Boolean)
	const source = []
	for (const name of [...new Set(listed)].sort()) {
		try {
			source.push({ path: name, sha256: hash(await fs.readFile(path.join(repositoryRoot, name))) })
		} catch (cause) {
			if (!(cause && typeof cause === "object" && "code" in cause && cause.code === "ENOENT")) throw cause
		}
	}
	const packages = []
	for (const name of ["@bjornpagen/bumbledb", "@bjornpagen/bumbledb-log"]) {
		const entrypoint = import.meta.resolve(name),
			directory = path.dirname(fileURLToPath(entrypoint))
		const manifest = JSON.parse(
			await fs.readFile(fileURLToPath(new URL("../package.json", entrypoint)), "utf8")
		)
		const files = []
		for (const entry of await fs.readdir(directory, { recursive: true, withFileTypes: true })) {
			if (entry.isFile()) {
				const file = path.join(entry.parentPath, entry.name)
				files.push({ path: path.relative(directory, file), sha256: hash(await fs.readFile(file)) })
			}
		}
		files.sort((a, b) => a.path.localeCompare(b.path))
		const provenance = JSON.parse(
			await fs.readFile(fileURLToPath(new URL("../pack-provenance.json", entrypoint)), "utf8")
		)
		packages.push({ name, version: manifest.version, provenance, files })
	}
	const nativePackage = `@bjornpagen/bumbledb-${process.platform}-${process.arch}`
	const nativeFile = createRequire(import.meta.resolve("@bjornpagen/bumbledb")).resolve(nativePackage)
	return {
		node: process.versions.node,
		packageManager: JSON.parse(await fs.readFile(path.join(repositoryRoot, "package.json"), "utf8"))
			.packageManager,
		head,
		changed,
		source,
		sourceDigest: hash(Buffer.from(json(source))),
		packages,
		native: { package: nativePackage, sha256: hash(await fs.readFile(nativeFile)) }
	}
})
const FileEntry = Schema.Struct({ path: Schema.String, sha256: Schema.String, bytes: Schema.String })
const Manifest = Schema.Struct({
	version: Schema.Literal(1),
	operation: EntityId,
	recordedAt: Schema.String,
	asOf: Schema.String,
	factsDigest: Schema.String,
	files: Schema.Array(FileEntry)
})
const CaptureMetadata = Schema.Struct({
	recordedAt: Schema.String,
	asOf: Schema.String,
	factsDigest: Schema.String,
	native: Schema.Unknown
})
const retainExact = (file: string, bytes: string | Uint8Array) =>
	Effect.gen(function* () {
		if (
			!(yield* retainOnce(file, bytes)) &&
			hash(yield* readBytes(file)) !== hash(typeof bytes === "string" ? Buffer.from(bytes) : bytes)
		)
			return yield* fail(
				"ArchiveEvidenceConflict",
				`Retained evidence differs: ${file}; capture a fresh operation`
			)
	})
const operationId = (id: string) => Result.getOrThrow(OperationId.from(entityId(id)))
const fail = (code: string, message: string) => Effect.fail(new Refusal({ code, message }))
const temporaryDirectory = Effect.acquireRelease(
	io("create private verification directory", () =>
		fs.mkdtemp(path.join(os.tmpdir(), "wagie-tools-archive-"))
	),
	(directory) =>
		io("remove verification directory", () => fs.rm(directory, { recursive: true, force: true })).pipe(
			Effect.orDie
		)
)

/** The archive contains regular files only. Its manifest covers every byte
 * outside the manifest itself, including native objects and recovery data.
 */
const fileIndex = (directory: string, excludeManifest = false) =>
	io("inventory archive files", async () => {
		const entries: (typeof FileEntry.Type)[] = []
		async function visit(relative: string): Promise<void> {
			for (const name of (await fs.readdir(path.join(directory, relative))).sort()) {
				const relativePath = path.posix.join(relative, name)
				if (excludeManifest && relativePath === "archive.json") continue
				const file = path.join(directory, relativePath),
					stat = await fs.lstat(file)
				if (stat.isDirectory()) await visit(relativePath)
				else if (stat.isFile())
					entries.push({
						path: relativePath,
						sha256: hash(await fs.readFile(file)),
						bytes: String(stat.size)
					})
				else throw new Error(`Archive contains a non-regular entry: ${relativePath}`)
			}
		}
		await visit("")
		return entries
	})
const copyTree = (source: string, target: string) =>
	Effect.gen(function* () {
		if (!(yield* exists(source))) return
		const files = yield* fileIndex(source)
		for (const entry of files) {
			const destination = path.join(target, entry.path)
			yield* privateDirectory(path.dirname(destination))
			const bytes = yield* readBytes(path.join(source, entry.path))
			if (!(yield* retainOnce(destination, bytes)) && hash(yield* readBytes(destination)) !== entry.sha256)
				return yield* fail("ArchiveEvidenceConflict", `Retained evidence differs: ${entry.path}`)
		}
	})

const unpack = (archive: string, directory: string) =>
	Effect.gen(function* () {
		const rejected: string[] = []
		yield* io("unpack native archive", () =>
			tar.extract({
				file: archive,
				cwd: directory,
				strict: true,
				preservePaths: false,
				preserveOwner: false,
				filter: (name, entry) => {
					const safe =
						"type" in entry &&
						(entry.type === "File" || entry.type === "Directory") &&
						!path.posix.isAbsolute(name) &&
						!name.split(/[\\/]/).includes("..")
					if (!safe) rejected.push(name)
					return safe
				}
			})
		)
		if (rejected.length) return yield* fail("ArchiveEntry", "The archive contains unsupported paths or links")
		const manifest = parseStrict(Manifest, JSON.parse(yield* readText(path.join(directory, "archive.json"))))
		const actual = yield* fileIndex(directory, true)
		if (json(actual) !== json(manifest.files))
			return yield* fail("ArchiveHash", "Archive file inventory or content hashes do not match")
		const source = { kind: "filesystem", directory: path.join(directory, "native") } as const
		const verified = yield* verifyBackup(source, { backup: operationId(manifest.operation) })
		const binding = yield* loadStoredBinding(path.join(directory, "binding.json"))
		if (json(verified.identity) !== json(binding.identity))
			return yield* fail("ArchiveIdentity", "Native backup identity disagrees with the captured binding")
		return { manifest, source, verified, binding }
	})

export const backupLedger = (input: { operation: string; output: string; provenance?: string }) =>
	Effect.gen(function* () {
		const operation = entityId(input.operation),
			{ history, binding, recoveryDirectory } = yield* Ledger
		const directory = path.join(path.dirname(recoveryDirectory), "maintenance", operation)
		yield* privateDirectory(directory)
		const intent = json({
			operation,
			binding,
			output: path.resolve(input.output),
			provenance: input.provenance ?? path.join(path.dirname(recoveryDirectory), "provenance")
		})
		const intentFile = path.join(directory, "intent.json")
		if (!(yield* retainOnce(intentFile, intent)) && (yield* readText(intentFile)) !== intent)
			return yield* fail("OperationReused", "This backup operation belongs to a different intent")
		const bundle = path.join(directory, "bundle")
		yield* privateDirectory(bundle)
		const captured = path.join(bundle, "archive.json")
		const destination = { kind: "filesystem", directory: path.join(bundle, "native") } as const
		if (!(yield* exists(captured))) {
			const inspection = yield* history.inspect()
			if (inspection.unknownCommands.count !== 0n)
				return yield* fail("UnresolvedCommands", "Resolve uncertain commands before capturing CURRENT")
			const requestScopes = []
			if (yield* exists(recoveryDirectory)) {
				for (const name of yield* io("list retained requests", () => fs.readdir(recoveryDirectory))) {
					if (!name.endsWith(".json")) continue
					const request = entityId(name.slice(0, -5))
					const reference = yield* retainedRequestReference(request)
					const current = sameIdentity(reference.identity, history.identity)
					requestScopes.push({ request, identity: reference.identity, current })
					// Migration closes the prior incarnation. Its retained commands are
					// historical evidence, never requests against the new authority.
					// Preserve their exact bytes below; do not reinterpret or replay them.
					if (!current) continue
					const resolved = yield* resolveRequest(request)
					if (resolved.kind !== "found")
						return yield* fail(
							"UnresolvedCommands",
							`Resolve retained request ${name} before capturing CURRENT`
						)
				}
			}
			const snapshot = yield* latest
			// Audit dates use UTC civil epoch days; the exact capture time uses epoch milliseconds.
			const asOf = yield* today("UTC"),
				recordedAt = yield* nowUnixMilliseconds
			const audit = yield* auditLedger(snapshot, asOf)
			const backed = yield* backup(binding, {
				operationId: operationId(operation),
				destination,
				schema: ledger
			})
			if (backed.kind !== "completed") return yield* fail(backed.kind, json(backed))
			const verified = yield* verifyBackup(destination, { backup: operationId(operation) })
			if (json(verified.state) !== json(snapshot.stateStamp))
				return yield* fail(
					"BackupStateChanged",
					"The capture and audit refer to different states; capture a fresh operation"
				)
			// Immutable stage files must agree after an interrupted packaging attempt.
			// In particular, never publish a new digest around an older retained audit.
			yield* retainExact(path.join(bundle, "binding.json"), json(binding))
			yield* retainExact(path.join(bundle, "audit.json"), json(audit))
			yield* retainExact(path.join(bundle, "request-scopes.json"), json(requestScopes))
			yield* retainOnce(
				path.join(bundle, "capture.json"),
				json({ recordedAt, asOf, factsDigest: audit.factsDigest, native: verified })
			)
			yield* copyTree(recoveryDirectory, path.join(bundle, "requests"))
			yield* copyTree(
				input.provenance ?? path.join(path.dirname(recoveryDirectory), "provenance"),
				path.join(bundle, "provenance")
			)
			yield* privateDirectory(path.join(bundle, "schema"))
			yield* retainExact(path.join(bundle, "schema", "current.json"), yield* readBytes(currentSchemaPath))
			for (const name of ["package.json", "pnpm-lock.yaml"])
				yield* retainExact(path.join(bundle, name), yield* readBytes(path.join(repositoryRoot, name)))
			yield* retainExact(path.join(bundle, "runtime.json"), json(yield* runtimeEvidence))
			const capture = parseStrict(
				CaptureMetadata,
				JSON.parse(yield* readText(path.join(bundle, "capture.json")))
			)
			yield* retainOnce(
				captured,
				json({
					version: 1,
					operation,
					recordedAt: capture.recordedAt,
					asOf: capture.asOf,
					factsDigest: capture.factsDigest,
					files: yield* fileIndex(bundle, true)
				})
			)
		}
		const manifest = parseStrict(Manifest, JSON.parse(yield* readText(captured)))
		if (json(yield* fileIndex(bundle, true)) !== json(manifest.files))
			return yield* fail("ArchiveHash", "The retained archive stage has changed")
		const verified = yield* verifyBackup(destination, { backup: operationId(operation) })
		const archive = path.join(directory, "completed.tar.gz")
		if (!(yield* exists(archive))) {
			const partial = path.join(directory, "packing.tar.gz")
			yield* io("package verified native backup", () =>
				tar.create({ file: partial, gzip: true, portable: true, noMtime: true, cwd: bundle }, ["."])
			)
			yield* io("retain complete archive", () => fs.rename(partial, archive))
		}
		const bytes = yield* readBytes(archive)
		yield* privateDirectory(path.dirname(path.resolve(input.output)))
		if (
			!(yield* retainOnce(path.resolve(input.output), bytes)) &&
			hash(yield* readBytes(input.output)) !== hash(bytes)
		)
			return yield* fail(
				"BackupOutputExists",
				"Choose a new archive path; existing bytes will not be replaced"
			)
		return {
			archive: path.resolve(input.output),
			sha256: hash(bytes),
			bytes: String(bytes.length),
			state: verified.state,
			factsDigest: manifest.factsDigest
		}
	})

/** Independently native-verifies, restores and reads the archive in an isolated
 * scope. A passing hash alone is not advertised as a proven usable backup.
 */
export const verifyArchive = (archive: string) =>
	Effect.scoped(
		Effect.gen(function* () {
			const directory = yield* temporaryDirectory
			const unpacked = path.join(directory, "unpacked")
			yield* privateDirectory(unpacked)
			const { manifest, source, binding, verified } = yield* unpack(archive, unpacked)
			const target = {
				...binding,
				directory: path.join(directory, "restored"),
				identity: { ...binding.identity, incarnationId: Result.getOrThrow(IncarnationId.from(yield* mintId)) }
			}
			const restored = yield* restore(source, target, {
				operationId: operationId(yield* mintId),
				backup: operationId(manifest.operation),
				schema: ledger
			})
			if (restored.kind !== "completed") return yield* fail(restored.kind, json(restored))
			if (restored.value.binding.kind !== "local")
				return yield* fail("RestoreBinding", "Expected a local restored binding")
			const history = yield* LocalHistory.open(restored.value.binding, ledger)
			const audit = yield* auditLedger(
				yield* history.snapshot({ consistency: { kind: "latest" } }),
				epochDay(BigInt(manifest.asOf))
			)
			if (audit.factsDigest !== manifest.factsDigest)
				return yield* fail("RestoreFacts", "Restored fact inventory differs from the captured audit")
			return {
				archive: path.resolve(archive),
				sha256: hash(yield* readBytes(archive)),
				source: verified,
				restoredIdentity: history.identity,
				audit
			}
		})
	)

/** Writes a NEW binding only after native restore and an independent fact audit.
 * Old request envelopes are retained as evidence; they cannot be replayed under
 * the new incarnation. Adoption never overwrites an existing live binding.
 */
export const restoreArchive = (input: {
	operation: string
	archive: string
	directory: string
	bindingOutput: string
}) =>
	Effect.scoped(
		Effect.gen(function* () {
			const temporary = yield* temporaryDirectory
			const { manifest, source, binding } = yield* unpack(input.archive, temporary)
			const parent = path.dirname(path.resolve(input.bindingOutput))
			yield* privateDirectory(parent)
			const intentFile = path.join(parent, `restore-${entityId(input.operation)}.json`)
			const identity = {
				...binding.identity,
				incarnationId: Result.getOrThrow(IncarnationId.from(yield* mintId))
			}
			const target = { ...binding, directory: path.resolve(input.directory), identity }
			const RestoreIntent = Schema.Struct({
				operation: EntityId,
				archiveHash: Schema.String,
				directory: Schema.String,
				incarnation: EntityId,
				bindingOutput: Schema.String
			})
			const request = {
				operation: input.operation,
				archiveHash: hash(yield* readBytes(input.archive)),
				directory: target.directory,
				incarnation: identity.incarnationId,
				bindingOutput: path.resolve(input.bindingOutput)
			}
			if (!(yield* retainOnce(intentFile, json(request)))) {
				const saved = parseStrict(RestoreIntent, JSON.parse(yield* readText(intentFile)))
				if (
					saved.archiveHash !== request.archiveHash ||
					saved.directory !== target.directory ||
					saved.bindingOutput !== request.bindingOutput
				)
					return yield* fail("OperationReused", "This restore operation belongs to another intent")
				target.identity.incarnationId = Result.getOrThrow(IncarnationId.parse(saved.incarnation))
			}
			const restored = yield* restore(source, target, {
				operationId: operationId(input.operation),
				backup: operationId(manifest.operation),
				schema: ledger
			})
			if (restored.kind !== "completed") return yield* fail(restored.kind, json(restored))
			if (restored.value.binding.kind !== "local")
				return yield* fail("RestoreBinding", "Expected a local restored binding")
			const history = yield* LocalHistory.open(restored.value.binding, ledger)
			const audit = yield* auditLedger(
				yield* history.snapshot({ consistency: { kind: "latest" } }),
				epochDay(BigInt(manifest.asOf))
			)
			if (audit.factsDigest !== manifest.factsDigest)
				return yield* fail("RestoreFacts", "Restored facts differ from the archive's captured audit")
			const provenance = path.join(parent, "provenance")
			yield* copyTree(path.join(temporary, "provenance"), provenance)
			yield* copyTree(
				path.join(temporary, "requests"),
				path.join(provenance, `requests-before-restore-${input.operation}`)
			)
			const bytes = json(restored.value.binding)
			if (
				!(yield* retainOnce(input.bindingOutput, bytes)) &&
				(yield* readText(input.bindingOutput)) !== bytes
			)
				return yield* fail(
					"BindingExists",
					"The existing binding differs; restored data is available for explicit adoption"
				)
			return { binding: restored.value.binding, bindingFile: path.resolve(input.bindingOutput), audit }
		})
	)
