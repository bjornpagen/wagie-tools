import { createHash } from "node:crypto"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { ChangeSet, Schema as DatabaseSchema, type Uuid } from "@bjornpagen/bumbledb"
import {
	Command,
	type CommandRef,
	type CommandResult,
	DatabaseId,
	type History,
	IncarnationId,
	type LocalBinding,
	LocalHistory,
	OperationId,
	type PublishedSnapshot,
	parseCommandRef,
	parseSchemaId,
	RequestId,
	renderCommandRef,
	type StateStamp,
	sameIdentity,
	TenantCache,
	type TerminalReceipt
} from "@bjornpagen/bumbledb-log"
import { Context, Effect, Layer, Result, Schema, type Scope } from "effect"
import { exists, privateDirectory, readBytes, readText, retainOnce } from "./core/files.ts"
import { epochDay, today, type UnixEpochDay } from "./core/time.ts"
import { EntityId, entityId, json, mintId, Refusal } from "./core/values.ts"
import ledger from "./schema.ts"

export type Snapshot = PublishedSnapshot<typeof ledger>
export type LedgerHistory = Omit<History<typeof ledger>, "close">
export type Draft = Effect.Success<ReturnType<typeof ChangeSet.builder<typeof ledger>>>
export const repositoryRoot = fileURLToPath(new URL("../", import.meta.url))
export const defaultBindingPath = path.join(repositoryRoot, "private", "binding.json")
export const currentSchemaPath = fileURLToPath(
	new URL("../migrations/0000-initial/schema.json", import.meta.url)
)
const BindingData = Schema.Struct({
	kind: Schema.Literal("local"),
	directory: Schema.String,
	identity: Schema.Struct({
		databaseId: Schema.String,
		incarnationId: Schema.String,
		schemaId: Schema.String
	})
})

export const parseStrict = <S extends Schema.ConstraintDecoder<unknown>>(
	shape: S,
	input: unknown
): S["Type"] => Schema.decodeUnknownSync(shape, { onExcessProperty: "error" })(input)
export const fingerprint = (value: unknown): string => createHash("sha256").update(json(value)).digest("hex")

/** Admin reads the recorded binding before applying the current-schema gate. */
export const loadStoredBinding = (file = defaultBindingPath) =>
	Effect.gen(function* () {
		const raw = parseStrict(BindingData, JSON.parse(yield* readText(file)))
		const binding: LocalBinding = {
			...raw,
			identity: {
				databaseId: Result.getOrThrow(DatabaseId.parse(raw.identity.databaseId)),
				incarnationId: Result.getOrThrow(IncarnationId.parse(raw.identity.incarnationId)),
				schemaId: Result.getOrThrow(parseSchemaId(raw.identity.schemaId))
			}
		}
		return binding
	})

export const loadBinding = (file = defaultBindingPath) =>
	Effect.gen(function* () {
		const binding = yield* loadStoredBinding(file)
		const compiled = yield* DatabaseSchema.compile(ledger)
		if (binding.identity.schemaId !== compiled.schemaId) {
			return yield* Effect.fail(
				new Refusal({
					code: "WrongSchema",
					message: "The binding does not name this application's schema. Open it with its matching code."
				})
			)
		}
		return binding
	})

export class Ledger extends Context.Service<
	Ledger,
	{ readonly history: LedgerHistory; readonly binding: LocalBinding; readonly recoveryDirectory: string }
>()("wagie-tools/Ledger") {}

export const ledgerLayer = (bindingFile = defaultBindingPath) =>
	Layer.effect(
		Ledger,
		Effect.gen(function* () {
			const binding = yield* loadBinding(bindingFile)
			const cache = yield* TenantCache.make(ledger, { maxOpen: 1 })
			const history = yield* cache.acquire(binding)
			return { history, binding, recoveryDirectory: path.join(path.dirname(bindingFile), "requests") }
		})
	)

export const latest = Effect.gen(function* () {
	const { history } = yield* Ledger
	return yield* history.snapshot({ consistency: { kind: "latest" } })
})

const Envelope = Schema.Struct({
	requestId: EntityId,
	action: Schema.String,
	inputHash: Schema.String,
	recordingDay: Schema.String,
	timeZone: Schema.String,
	commandRef: Schema.String,
	commandBytes: Schema.String
})

function accepted(receipt: TerminalReceipt): Effect.Effect<TerminalReceipt, Refusal> {
	if (receipt.outcome.kind !== "committed" && receipt.outcome.kind !== "no-change") {
		return Effect.fail(
			new Refusal({
				code: receipt.outcome.kind,
				message: json({ command: renderCommandRef(receipt.command), outcome: receipt.outcome })
			})
		)
	}
	return Effect.succeed(receipt)
}

const dispatch = (command: Command<typeof ledger>) =>
	Effect.gen(function* () {
		const { history } = yield* Ledger
		const submitted = yield* history.submit(command, {
			attempts: 4,
			backoff: { baseMillis: 5, capMillis: 100 }
		})
		if (submitted.kind !== "decided")
			return yield* Effect.fail(
				new Refusal({
					code: submitted.kind,
					message: json({
						request: command.ref.id.requestId,
						command: renderCommandRef(command.ref),
						action: "command resolve"
					})
				})
			)
		const receipt = yield* accepted(submitted.receipt)
		const readback = yield* history.snapshot({ consistency: { kind: "at-least", at: receipt.decisionAt } })
		if (
			readback.stateStamp.incarnation !== receipt.stateAt.incarnation ||
			readback.stateStamp.dataRevision < receipt.stateAt.dataRevision
		)
			return yield* Effect.fail(
				new Refusal({
					code: "ReadbackUnavailable",
					message: "The decision is recorded; resolve the original command for its result"
				})
			)
		return receipt
	})

const sameRecordingDay = (timeZone: string, recordingDay: UnixEpochDay) =>
	Effect.gen(function* () {
		if ((yield* today(timeZone)) !== recordingDay)
			return yield* Effect.fail(
				new Refusal({
					code: "RecordingDayChanged",
					message:
						"The civil recording date changed. Resolve any original outcome, then calculate a fresh intent."
				})
			)
	})

/** Retained command identity is authoritative even after a schema migration.
 * A backup preserves every envelope, but only the matching history can resolve it.
 */
export const retainedRequestReference = (request: Uuid) =>
	Effect.gen(function* () {
		const { recoveryDirectory } = yield* Ledger
		const envelope = parseStrict(
			Envelope,
			JSON.parse(yield* readText(path.join(recoveryDirectory, `${request}.json`)))
		)
		return Result.getOrThrow(parseCommandRef(envelope.commandRef))
	})

const resolveInCurrentHistory = (reference: CommandRef) =>
	Effect.gen(function* () {
		const { history } = yield* Ledger
		if (!sameIdentity(reference.identity, history.identity))
			return yield* Effect.fail(
				new Refusal({
					code: "RequestHistoryChanged",
					message: json({
						command: renderCommandRef(reference),
						message:
							"This retained request belongs to a prior history. Inspect its original history or backup for the outcome; it cannot be replayed against the current ledger."
					})
				})
			)
		return yield* history.resolve(reference)
	})

export const resolveRequest = (request: Uuid) =>
	Effect.gen(function* () {
		return yield* resolveInCurrentHistory(yield* retainedRequestReference(request))
	})

/** Resolve a retained request before doing any fresh planning or minting. */
export const previousRequest = (request: Uuid, action: string, input: unknown) =>
	Effect.gen(function* () {
		const { recoveryDirectory } = yield* Ledger
		const file = path.join(recoveryDirectory, `${request}.json`)
		if (!(yield* exists(file))) return undefined
		const envelope = parseStrict(Envelope, JSON.parse(yield* readText(file)))
		if (envelope.action !== action || envelope.inputHash !== fingerprint(input)) {
			return yield* Effect.fail(
				new Refusal({ code: "RequestReused", message: "This request identity belongs to another intent" })
			)
		}
		const resolved = yield* resolveInCurrentHistory(Result.getOrThrow(parseCommandRef(envelope.commandRef)))
		if (resolved.kind === "found") return yield* accepted(resolved.receipt)
		if (resolved.kind !== "not-recorded-at") {
			return yield* Effect.fail(
				new Refusal({
					code: "OutcomeUnknown",
					message: "The original request has no confirmed outcome. Resolve it before creating another intent."
				})
			)
		}
		// Not recorded at one observed tip is not proof of failure. Resubmit
		// the exact retained native command; its identity and precondition
		// judge duplicates and state changes without minting a new intent.
		yield* sameRecordingDay(envelope.timeZone, envelopeDay(envelope.recordingDay))
		const command = yield* Command.decode(Buffer.from(envelope.commandBytes, "base64"), ledger)
		if (renderCommandRef(command.ref) !== envelope.commandRef)
			return yield* Effect.fail(
				new Refusal({
					code: "RecoveryMismatch",
					message: "The retained bytes and command reference disagree"
				})
			)
		return yield* dispatch(command)
	})

export const commit = (intent: {
	readonly request: Uuid
	readonly action: string
	readonly input: unknown
	readonly at: StateStamp
	readonly recordingDay: UnixEpochDay
	readonly timeZone: string
	readonly result: CommandResult
	readonly changes: ChangeSet<typeof ledger>
}) =>
	Effect.gen(function* () {
		const { history, recoveryDirectory } = yield* Ledger
		yield* sameRecordingDay(intent.timeZone, intent.recordingDay)
		const command = yield* Command.seal({
			scope: history.identity,
			id: {
				receiptEpoch: history.receiptEpoch,
				requestId: Result.getOrThrow(RequestId.from(entityId(intent.request)))
			},
			precondition: { kind: "exact-state", at: intent.at },
			changes: intent.changes,
			result: intent.result
		})
		const commandBytes = yield* Command.encode(command)
		yield* privateDirectory(recoveryDirectory)
		const created = yield* retainOnce(
			path.join(recoveryDirectory, `${intent.request}.json`),
			json({
				requestId: intent.request,
				action: intent.action,
				inputHash: fingerprint(intent.input),
				recordingDay: intent.recordingDay,
				timeZone: intent.timeZone,
				commandRef: renderCommandRef(command.ref),
				commandBytes: Buffer.from(commandBytes).toString("base64")
			})
		)
		if (!created) {
			const winner = yield* previousRequest(intent.request, intent.action, intent.input)
			if (!winner)
				return yield* Effect.fail(
					new Refusal({ code: "RecoveryMissing", message: "The concurrently retained request is missing" })
				)
			return winner
		}
		// Encoding and durable retention can straddle midnight too.
		yield* sameRecordingDay(intent.timeZone, intent.recordingDay)
		return yield* dispatch(command)
	})

/** Explicit creation from the current schema, with no migration chain.
 * Native creation checks the canonical artifact against the compiled schema.
 * Ordinary startup only opens an existing binding.
 */
export const createHistory = (directory: string) =>
	Effect.gen(function* () {
		const compiled = yield* DatabaseSchema.compile(ledger)
		const binding: LocalBinding = {
			kind: "local",
			directory,
			identity: {
				databaseId: Result.getOrThrow(DatabaseId.from(yield* mintId)),
				incarnationId: Result.getOrThrow(IncarnationId.from(yield* mintId)),
				schemaId: compiled.schemaId
			}
		}
		const history = yield* LocalHistory.create(binding, ledger, {
			creation: {
				operationId: Result.getOrThrow(OperationId.from(yield* mintId)),
				artifact: yield* readBytes(currentSchemaPath)
			}
		})
		return { history, binding }
	})

export const planAndCommit = <A, E, R>(options: {
	request: Uuid
	action: string
	input: A
	recordingDay: UnixEpochDay
	timeZone: string
	plan: (snapshot: Snapshot, draft: Draft) => Effect.Effect<CommandResult, E, R | Scope.Scope>
}) =>
	Effect.gen(function* () {
		const previous = yield* previousRequest(options.request, options.action, options.input)
		if (previous) return previous
		const snapshot = yield* latest
		const draft = yield* ChangeSet.builder(ledger)
		const result = yield* options.plan(snapshot, draft)
		return yield* commit({ ...options, at: snapshot.stateStamp, result, changes: yield* draft.finish() })
	})

// Persisted calendar metadata has an explicit parser; native values are never
// reinterpreted as clock milliseconds merely because both use bigint storage.
export const envelopeDay = (value: string): UnixEpochDay => epochDay(BigInt(value))
