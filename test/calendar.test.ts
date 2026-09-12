import assert from "node:assert/strict"
import * as path from "node:path"
import { test } from "node:test"
import { ChangeSet, query, v } from "@bjornpagen/bumbledb"
import { Effect } from "effect"
import { parseCalendarDate } from "../src/core/time.ts"
import { mintId } from "../src/core/values.ts"
import { ensureFilings } from "../src/filing-coverage.ts"
import {
	expandCalendar,
	followingBusinessDay,
	installCalendarFacts,
	nominalDeadline
} from "../src/policy/calendar.ts"
import { rows } from "../src/queries.ts"
import { Ledger } from "../src/runtime.ts"
import { formPolicy, forms } from "../src/schema/vocabulary.ts"
import * as S from "../src/schema.ts"
import { apply, withHistory } from "./native-history.ts"

test("reviewed calendar grids cover leap years and authority-specific observed holidays; gaps refuse natively", async () => {
	const evidence = "Synthetic calendar qualification, not live policy"
	const base = { fromYear: 2024, throughYear: 2027, evidence }
	const federal = {
		...base,
		authority: "FederalDC",
		holidays: [
			{ kind: "Fixed", month: 1, day: 1, observe: "NearestWeekday", evidence },
			{ kind: "Fixed", month: 4, day: 16, observe: "NearestWeekday", evidence },
			{ kind: "Fixed", month: 7, day: 4, observe: "NearestWeekday", evidence },
			{ kind: "NthWeekday", month: 1, weekday: 1, occurrence: 3, offsetDays: 0, evidence },
			{ kind: "LastWeekday", month: 5, weekday: 1, evidence }
		]
	}
	const texas = {
		...base,
		authority: "Texas",
		holidays: [{ kind: "Fixed", month: 3, day: 2, observe: "None", evidence }]
	}
	const calendar = expandCalendar(federal)
	assert.equal(calendar.days.length, 1461)
	assert.equal(calendar.periods.filter((row) => row.kind === "Quarter").length, 16)
	assert.equal(
		calendar.periods.find((row) => row.kind === "Month" && row.year === 2024n && row.ordinal === 2n)?.span
			.end,
		parseCalendarDate("2024-03-01")
	)
	assert.equal(
		nominalDeadline("FollowingMonth15", parseCalendarDate("2026-07-01")),
		parseCalendarDate("2026-07-15")
	)
	assert.equal(
		nominalDeadline("FollowingMonthEnd", parseCalendarDate("2027-01-01")),
		parseCalendarDate("2027-01-31")
	)
	await withHistory((history, binding, directory) =>
		Effect.gen(function* () {
			const release = yield* mintId
			const draft = yield* ChangeSet.builder(S.ledger)
			yield* draft.insert(S.PolicyRelease, [
				{ id: release, sha256: "synthetic-calendar", title: evidence, evidence, recordedAt: 0n }
			])
			yield* installCalendarFacts(draft, release, federal)
			yield* installCalendarFacts(draft, release, texas)
			assert.equal((yield* apply(history, yield* draft.finish())).outcome.kind, "committed")
			const snapshot = yield* history.snapshot({ consistency: { kind: "latest" } })
			for (const [authority, from, expected] of [
				["FederalDC", "2024-02-29", "2024-02-29"],
				["FederalDC", "2026-01-19", "2026-01-20"],
				["FederalDC", "2026-05-25", "2026-05-26"],
				["FederalDC", "2026-04-16", "2026-04-17"],
				["Texas", "2026-04-16", "2026-04-16"],
				["FederalDC", "2026-07-03", "2026-07-06"],
				["Texas", "2026-07-03", "2026-07-03"]
			] as const)
				assert.equal(
					yield* followingBusinessDay(snapshot, release, authority, parseCalendarDate(from)),
					parseCalendarDate(expected)
				)
			assert.equal(
				(yield* Effect.result(
					followingBusinessDay(snapshot, release, "FederalDC", parseCalendarDate("2027-12-31"))
				))._tag,
				"Failure",
				"observed next-year holiday cannot silently roll beyond reviewed coverage"
			)
			assert.equal(
				(yield* Effect.result(
					followingBusinessDay(snapshot, release, "FederalDC", parseCalendarDate("2023-12-29"))
				))._tag,
				"Failure"
			)
			const removed = calendar.days.find((row) => row.span.start === parseCalendarDate("2024-02-29"))
			assert.ok(removed)
			const gap = yield* ChangeSet.builder(S.ledger)
			yield* gap.delete(S.BusinessDay, [{ release, authority: "FederalDC", ...removed }])
			assert.equal((yield* apply(history, yield* gap.finish())).outcome.kind, "invariant-rejected")
			assert.deepEqual(
				(yield* history.snapshot({ consistency: { kind: "latest" } })).stateStamp,
				snapshot.stateStamp
			)
			const business = yield* mintId
			const setup = yield* ChangeSet.builder(S.ledger)
			yield* setup.insert(S.Business, [
				{
					id: business,
					name: "Calendar enrollment",
					ein: "00-0000055",
					state: "TX",
					timeZone: "UTC",
					recordedAt: 0n
				}
			])
			yield* setup.insert(S.PolicyBinding, [{ business, release, evidence }])
			for (const form of forms.filter((form) => formPolicy[form].due !== "RecordedEvent"))
				yield* setup.insert(S.FilingRule, [
					{
						id: yield* mintId,
						release,
						form,
						authority: formPolicy[form].authority,
						periodKind: formPolicy[form].period,
						dueRule: "FollowingMonthEnd",
						evidence
					}
				])
			assert.equal((yield* apply(history, yield* setup.finish())).outcome.kind, "committed")
			const originalFacts = query(S.ledger).rule((r) => {
				const row = v(S.OriginalFiling)
				return r.match(S.OriginalFiling, row).find(row)
			})
			const ensure = {
				request: yield* mintId,
				business,
				throughYear: 2025,
				enrollment: { startsOn: "2024-02-05", evidence }
			}
			const enrolled = yield* ensureFilings(ensure)
			assert.equal(enrolled.outcome.kind, "committed")
			const firstView = yield* history.snapshot({ consistency: { kind: "latest" } })
			const initial = yield* rows(firstView, originalFacts, {})
			assert.equal(
				initial.length,
				18,
				"business returns cover complete canonical periods; W-2 begins with paid employees"
			)
			assert.equal(initial.filter((row) => row.form === "F941").length, 8)
			const repeated = yield* ensureFilings({ ...ensure, request: yield* mintId })
			assert.equal(repeated.outcome.kind, "no-change")
			assert.deepEqual(
				(yield* history.snapshot({ consistency: { kind: "latest" } })).stateStamp,
				firstView.stateStamp
			)
			yield* ensureFilings({ request: yield* mintId, business, throughYear: 2026 })
			const expanded = yield* rows(
				yield* history.snapshot({ consistency: { kind: "latest" } }),
				originalFacts,
				{}
			)
			assert.equal(expanded.length, 27)
			assert.ok(initial.every((row) => expanded.some((later) => row.filing === later.filing)))
		}).pipe(
			Effect.provideService(Ledger, { history, binding, recoveryDirectory: path.join(directory, "requests") })
		)
	)
})

test("day after Thanksgiving follows the fourth Thursday even when Friday occurs five times", () => {
	const calendar = expandCalendar({
		authority: "Texas",
		fromYear: 2024,
		throughYear: 2030,
		evidence: "Synthetic calendar",
		holidays: [
			{
				kind: "NthWeekday",
				month: 11,
				weekday: 4,
				occurrence: 4,
				offsetDays: 1,
				evidence: "Day after Thanksgiving"
			}
		]
	})
	for (const date of ["2024-11-29", "2026-11-27", "2030-11-29"])
		assert.equal(calendar.days.find((row) => row.span.start === parseCalendarDate(date))?.eligible, false)
	assert.equal(
		calendar.days.find((row) => row.span.start === parseCalendarDate("2024-11-22"))?.eligible,
		true
	)
})
