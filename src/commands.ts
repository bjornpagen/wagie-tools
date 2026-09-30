import { createHash } from "node:crypto"
import { query, type Uuid, v } from "@bjornpagen/bumbledb"
import type { CommandResult } from "@bjornpagen/bumbledb-log"
import { Effect, type Scope } from "effect"
import { today, type UnixEpochDay } from "./core/time.ts"
import { Refusal } from "./core/values.ts"
import { rows } from "./queries.ts"
import { type Draft, latest, planAndCommit, previousRequest, type Snapshot } from "./runtime.ts"
import * as S from "./schema.ts"

export const businessFacts = query(S.ledger).rule((r) => {
	const row = v(S.Business)
	return r.match(S.Business, row).find(row)
})

/** Statement identity is content: a UUIDv8 carrying the text's SHA-256, so
 * identical prose written by any command, at any time, is the same fact. */
export const statementId = (text: string): Uuid => {
	const hex = createHash("sha256").update(text, "utf8").digest("hex")
	const variant = ((Number.parseInt(hex.slice(16, 17), 16) & 0x3) | 0x8).toString(16)
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}` as Uuid
}

/** Stores prose once and returns its statement id. */
export type Note = (text: string) => Effect.Effect<Uuid, unknown, Scope.Scope>

export const statementWriter = (draft: Draft): Note => {
	const drafted = new Set<string>()
	return (text) =>
		Effect.gen(function* () {
			if (!/\S/.test(text))
				return yield* Effect.fail(new Refusal({ code: "EvidenceBlank", message: "Evidence text is blank" }))
			const id = statementId(text)
			if (!drafted.has(id)) {
				yield* draft.insert(S.Statement, [{ id, text }])
				drafted.add(id)
			}
			return id
		})
}

/** Domain commands share recovery, employer clock, and exact-state admission.
 * This capability is internal; the CLI never accepts arbitrary changes.
 */
export const businessCommand = <A, E, R>(options: {
	request: Uuid
	business: Uuid
	action: string
	input: A
	plan: (context: {
		snapshot: Snapshot
		draft: Draft
		recordingDay: UnixEpochDay
		note: Note
	}) => Effect.Effect<CommandResult, E, R | Scope.Scope>
}) =>
	Effect.gen(function* () {
		const previous = yield* previousRequest(options.request, options.action, options.input)
		if (previous) return previous
		const company = (yield* rows(yield* latest, businessFacts, {})).find((row) => row.id === options.business)
		if (!company)
			return yield* Effect.fail(
				new Refusal({ code: "BusinessMissing", message: `No business ${options.business}` })
			)
		const recordingDay = yield* today(company.timeZone)
		return yield* planAndCommit({
			...options,
			recordingDay,
			timeZone: company.timeZone,
			plan: (snapshot, draft) =>
				Effect.gen(function* () {
					const current = (yield* rows(snapshot, businessFacts, {})).find(
						(row) => row.id === options.business
					)
					if (!current || current.timeZone !== company.timeZone)
						return yield* Effect.fail(
							new Refusal({
								code: "BusinessChanged",
								message: "The employer clock configuration changed; start a fresh request"
							})
						)
					return yield* options.plan({
						snapshot,
						draft,
						recordingDay,
						note: statementWriter(draft)
					})
				})
		})
	})
