import { query, type Uuid, v } from "@bjornpagen/bumbledb"
import type { CommandResult } from "@bjornpagen/bumbledb-log"
import { Effect, type Scope } from "effect"
import { nowUnixMilliseconds, today, type UnixEpochDay, type UnixEpochMilliseconds } from "./core/time.ts"
import { Refusal } from "./core/values.ts"
import { rows } from "./queries.ts"
import { type Draft, latest, planAndCommit, previousRequest, type Snapshot } from "./runtime.ts"
import * as S from "./schema.ts"

export const businessFacts = query(S.ledger).rule((r) => {
	const row = v(S.Business)
	return r.match(S.Business, row).find(row)
})

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
		recordedAt: UnixEpochMilliseconds
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
		const recordedAt = yield* nowUnixMilliseconds
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
					return yield* options.plan({ snapshot, draft, recordingDay, recordedAt })
				})
		})
	})
