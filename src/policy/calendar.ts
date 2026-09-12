import { ALLEN, type Fact, query, type Uuid, v } from "@bjornpagen/bumbledb"
import { Effect, Schema } from "effect"
import {
	addCalendarDays,
	calendarDays,
	civilDayPoint,
	civilDaySpan,
	epochDay,
	fromCalendarDate,
	periodSpan,
	toCalendarDate,
	type UnixEpochDay
} from "../core/time.ts"
import { mintId, Nonblank, Refusal } from "../core/values.ts"
import { rows } from "../queries.ts"
import { type Draft, parseStrict, type Snapshot } from "../runtime.ts"
import { YearNumber } from "../schema/input.ts"
import * as S from "../schema.ts"

const integer = (minimum: number, maximum: number) => Schema.Int.check(Schema.isBetween({ minimum, maximum }))
const Month = integer(1, 12),
	Weekday = integer(0, 6)
const HolidayRule = Schema.Union([
	Schema.Struct({
		kind: Schema.Literal("Fixed"),
		month: Month,
		day: integer(1, 31),
		observe: Schema.Literals(["None", "NearestWeekday", "FollowingMonday"]),
		evidence: Nonblank
	}),
	Schema.Struct({
		kind: Schema.Literal("NthWeekday"),
		month: Month,
		weekday: Weekday,
		occurrence: integer(1, 4),
		offsetDays: integer(-31, 31),
		evidence: Nonblank
	}),
	Schema.Struct({ kind: Schema.Literal("LastWeekday"), month: Month, weekday: Weekday, evidence: Nonblank })
])
export const CalendarInput = Schema.Struct({
	authority: Schema.Literals(S.Authority.handles),
	fromYear: YearNumber,
	throughYear: YearNumber,
	holidays: Schema.Array(HolidayRule),
	evidence: Nonblank
}).check(Schema.makeFilter((input) => input.fromYear <= input.throughYear || "Calendar horizon is inverted"))

/** Sunday = 0 through Saturday = 6; epoch day 0 was Thursday (4).
 * This uses calendar-date steps, independently of clock duration and DST.
 */
export const weekday = (day: UnixEpochDay): number => Number((((day + 4n) % 7n) + 7n) % 7n)

function holidayDate(year: number, rule: typeof HolidayRule.Type): UnixEpochDay {
	switch (rule.kind) {
		case "Fixed": {
			const day = fromCalendarDate({ year, month: rule.month, day: rule.day })
			const week = weekday(day)
			const adjustment = {
				None: 0,
				NearestWeekday: week === 6 ? -1 : week === 0 ? 1 : 0,
				FollowingMonday: week === 6 ? 2 : week === 0 ? 1 : 0
			}[rule.observe]
			return epochDay(day + BigInt(adjustment))
		}
		case "NthWeekday": {
			const first = fromCalendarDate({ year, month: rule.month, day: 1 })
			return addCalendarDays(
				first,
				calendarDays(
					BigInt(((rule.weekday - weekday(first) + 7) % 7) + (rule.occurrence - 1) * 7 + rule.offsetDays)
				)
			)
		}
		case "LastWeekday": {
			const last = epochDay(periodSpan(year, "Month", rule.month).end - 1n)
			return epochDay(last - BigInt((weekday(last) - rule.weekday + 7) % 7))
		}
	}
}

/** Pure Gregorian expansion of explicitly reviewed, bounded policy input.
 * No holiday roster or supported tax year is guessed by the running calculator.
 */
export function expandCalendar(payload: unknown) {
	const input = parseStrict(CalendarInput, payload)
	const span = civilDaySpan(
		periodSpan(input.fromYear, "Year").start,
		periodSpan(input.throughYear, "Year").end
	)
	const holidays = new Map<UnixEpochDay, string[]>()
	// An observed New Year's Day can fall in the preceding calendar year.
	for (let year = input.fromYear - 1; year <= input.throughYear + 1; year++) {
		for (const rule of input.holidays) {
			const day = holidayDate(year, rule)
			if (day < span.start || day >= span.end) continue
			holidays.set(day, [...(holidays.get(day) ?? []), rule.evidence])
		}
	}
	const periods: Pick<Fact<typeof S.CalendarPeriod>, "kind" | "year" | "ordinal" | "span">[] = []
	const counts = { Year: 1, Quarter: 4, Month: 12 } as const
	for (let year = input.fromYear; year <= input.throughYear; year++)
		for (const kind of S.PeriodKind.handles)
			for (let ordinal = 1; ordinal <= counts[kind]; ordinal++)
				periods.push({
					kind,
					year: BigInt(year),
					ordinal: BigInt(ordinal),
					span: periodSpan(year, kind, ordinal)
				})
	const days: Pick<Fact<typeof S.BusinessDay>, "span" | "eligible" | "evidence">[] = []
	for (let day = span.start; day < span.end; day = epochDay(day + 1n)) {
		const holiday = holidays.get(day)
		days.push({
			span: civilDayPoint(day),
			eligible: weekday(day) !== 0 && weekday(day) !== 6 && holiday === undefined,
			evidence: holiday?.join("\n") ?? input.evidence
		})
	}
	return { authority: input.authority, evidence: input.evidence, span, periods, days }
}

/** Used by explicit policy installation, within its single retained command. */
export const installCalendarFacts = (draft: Draft, release: Uuid, payload: unknown) =>
	Effect.gen(function* () {
		const calendar = expandCalendar(payload)
		const { authority, span, evidence } = calendar
		for (const kind of S.PeriodKind.handles)
			yield* draft.insert(S.CalendarCoverage, [{ release, authority, kind, span }])
		const periods = []
		for (const period of calendar.periods) {
			const fact = { id: yield* mintId, release, authority, ...period }
			periods.push(fact)
			yield* draft.insert(S.CalendarPeriod, [fact])
		}
		yield* draft.insert(S.BusinessDayCoverage, [{ release, authority, span, evidence }])
		yield* draft.insert(
			S.BusinessDay,
			calendar.days.map((day) => ({ release, authority, ...day }))
		)
		return { ...calendar, periods }
	})

export function nominalDeadline(
	rule: (typeof S.DueRule.handles)[number],
	periodEnd: UnixEpochDay
): UnixEpochDay {
	const { year, month } = toCalendarDate(periodEnd)
	return {
		FollowingMonth15: () => fromCalendarDate({ year, month, day: 15 }),
		FollowingMonthEnd: () => epochDay(periodSpan(year, "Month", month).end - 1n)
	}[rule]()
}

const eligibleDays = query(S.ledger).rule((r) => {
	const { span } = v(S.BusinessDay)
	return r
		.match(S.BusinessDay, {
			release: r.param("release"),
			authority: r.param("authority"),
			eligible: true,
			span
		})
		.where(r.allen(span, ALLEN.after | ALLEN.metBy | ALLEN.equals, r.param("nominal")))
		.find({ span })
})
const coveredDays = query(S.ledger).rule((r) => {
	const { span } = v(S.BusinessDayCoverage)
	return r
		.match(S.BusinessDayCoverage, { release: r.param("release"), authority: r.param("authority"), span })
		.where(r.pointIn(r.param("day"), span))
		.find({ span })
})

/** The native query selects eligible calendar days; the least returned date is
 * the following business day. Missing coverage fails instead of extrapolating.
 */
export const followingBusinessDay = (
	snapshot: Snapshot,
	release: Uuid,
	authority: (typeof S.Authority.handles)[number],
	nominal: UnixEpochDay
) =>
	Effect.gen(function* () {
		const coverage = (yield* rows(snapshot, coveredDays, { release, authority, day: nominal }))[0]
		if (!coverage)
			return yield* Effect.fail(
				new Refusal({
					code: "CalendarCoverageMissing",
					message: "The reviewed business calendar does not cover the nominal deadline"
				})
			)
		const candidates = yield* rows(snapshot, eligibleDays, {
			release,
			authority,
			nominal: civilDayPoint(nominal)
		})
		const result = candidates
			.filter((row) => row.span.end <= coverage.span.end)
			.reduce<UnixEpochDay | undefined>(
				(earliest, row) =>
					earliest === undefined || row.span.start < earliest ? epochDay(row.span.start) : earliest,
				undefined
			)
		if (result === undefined)
			return yield* Effect.fail(
				new Refusal({
					code: "CalendarCoverageMissing",
					message: "Extend the reviewed business calendar to resolve this deadline"
				})
			)
		return result
	})
