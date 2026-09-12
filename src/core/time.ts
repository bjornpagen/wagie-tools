import { DateTime, Effect, Schema } from "effect"
import { Refusal } from "./values.ts"

/**
 * Calendar-date coordinate in the proleptic Gregorian calendar:
 * 0 = 1970-01-01, 1 = 1970-01-02, -1 = 1969-12-31.
 * One unit advances one calendar date. It is neither a duration nor an instant.
 * It is NOT Julian Day Number (different epoch and noon boundary), Modified
 * Julian Date, or a day-of-year. Supported formatting range: years 0001–9999.
 *
 * UTC midnight is only the conversion coordinate for a date's year/month/day.
 * Choosing today's date from an instant requires the employer's named zone.
 * Never divide a local-midnight elapsed duration by 24h: DST days vary in length.
 */
export const UnixEpochDay = Schema.BigInt.check(
	Schema.isBetweenBigInt({ minimum: -719162n, maximum: 2932896n })
).pipe(Schema.brand("UnixEpochDay"))
export type UnixEpochDay = typeof UnixEpochDay.Type

/** Milliseconds since 1970-01-01T00:00:00Z, POSIX/JavaScript convention (no leap seconds). */
export const UnixEpochMilliseconds = Schema.BigInt.check(
	Schema.isBetweenBigInt({ minimum: -62135596800000n, maximum: 253402300799999n })
).pipe(Schema.brand("UnixEpochMilliseconds"))
export type UnixEpochMilliseconds = typeof UnixEpochMilliseconds.Type

/** Number of whole calendar-date steps; this is a duration, not a date coordinate. */
export const CalendarDays = Schema.BigInt.pipe(Schema.brand("CalendarDays"))
export type CalendarDays = typeof CalendarDays.Type

export const epochDay = Schema.decodeUnknownSync(UnixEpochDay)
export const epochMilliseconds = Schema.decodeUnknownSync(UnixEpochMilliseconds)
export const calendarDays = Schema.decodeUnknownSync(CalendarDays)
const UTC_DAY_MILLISECONDS = 86400000n

export const CivilDaySpan = Schema.Struct({ start: UnixEpochDay, end: UnixEpochDay }).check(
	Schema.makeFilter((span) => span.start < span.end || "Civil-day span must be nonempty and end-exclusive")
)
export type CivilDaySpan = typeof CivilDaySpan.Type
export const civilDaySpan = (start: UnixEpochDay, end: UnixEpochDay): CivilDaySpan =>
	Schema.decodeUnknownSync(CivilDaySpan)({ start, end })

/** A single date as [day, day + 1). Native fixed-width interval fields preserve
 * this point when proving membership in policy, election, and calendar spans.
 */
export const civilDayPoint = (day: UnixEpochDay): CivilDaySpan => civilDaySpan(day, epochDay(day + 1n))

export function fromCalendarDate(parts: { year: number; month: number; day: number }): UnixEpochDay {
	const utc = DateTime.makeUnsafe({ year: parts.year, month: parts.month, day: parts.day })
	const parsed = DateTime.toPartsUtc(utc)
	if (parsed.year !== parts.year || parsed.month !== parts.month || parsed.day !== parts.day) {
		throw new Refusal({ code: "InvalidDate", message: "The supplied Gregorian date does not exist" })
	}
	return epochDay(BigInt(DateTime.toEpochMillis(utc)) / UTC_DAY_MILLISECONDS)
}

/** Human-readable dates are parsed/formatted only at I/O boundaries, never stored as strings. */
export function parseCalendarDate(input: string): UnixEpochDay {
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input)
	if (!match) throw new Refusal({ code: "InvalidDate", message: "Use YYYY-MM-DD" })
	return fromCalendarDate({ year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) })
}

export const toCalendarDate = (day: UnixEpochDay) =>
	DateTime.toPartsUtc(DateTime.makeUnsafe(Number(day * UTC_DAY_MILLISECONDS)))
export const formatCalendarDate = (day: UnixEpochDay): string =>
	DateTime.formatIsoDateUtc(DateTime.makeUnsafe(Number(day * UTC_DAY_MILLISECONDS)))
export const addCalendarDays = (day: UnixEpochDay, amount: CalendarDays): UnixEpochDay =>
	epochDay(day + amount)
export const countCalendarDays = (span: CivilDaySpan): CalendarDays => calendarDays(span.end - span.start)

export function localDayAt(instant: UnixEpochMilliseconds, timeZone: string): UnixEpochDay {
	const zoned = DateTime.setZoneNamedUnsafe(DateTime.makeUnsafe(Number(instant)), timeZone)
	return fromCalendarDate(DateTime.toParts(zoned))
}

export const nowUnixMilliseconds = DateTime.now.pipe(
	Effect.map((value) => epochMilliseconds(BigInt(DateTime.toEpochMillis(value))))
)
export const today = (timeZone: string) =>
	nowUnixMilliseconds.pipe(Effect.map((instant) => localDayAt(instant, timeZone)))

export function periodSpan(year: number, kind: "Year" | "Quarter" | "Month", ordinal = 1): CivilDaySpan {
	const months = { Year: 12, Quarter: 3, Month: 1 }[kind]
	if (!Number.isInteger(ordinal) || ordinal < 1 || ordinal > 12 / months) {
		throw new Refusal({ code: "InvalidPeriod", message: "Period ordinal is out of range" })
	}
	const start = DateTime.makeUnsafe({ year, month: (ordinal - 1) * months + 1, day: 1 })
	const end = DateTime.add(start, { months })
	return civilDaySpan(
		fromCalendarDate(DateTime.toPartsUtc(start)),
		fromCalendarDate(DateTime.toPartsUtc(end))
	)
}
