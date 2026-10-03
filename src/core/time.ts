import { Refusal } from "./values.ts"

/** A civil date is an i64 Unix epoch day: 0 = 1970-01-01. Every period is the
 * half-open interval [start, end) of such days. Dates are parsed and printed
 * only at the boundary; inside, a day is a number on one axis. */
export type Span = { readonly start: bigint; readonly end: bigint }

/** Howard Hinnant's days_from_civil / civil_from_days, proleptic Gregorian. */
export const dayOf = (year: number, month: number, day: number): bigint => {
	const y = month <= 2 ? year - 1 : year
	const era = Math.floor(y / 400)
	const yoe = y - era * 400
	const doy = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1
	const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy
	return BigInt(era * 146097 + doe - 719468)
}

export const civil = (day: bigint) => {
	const z = Number(day) + 719468
	const era = Math.floor(z / 146097)
	const doe = z - era * 146097
	const yoe = Math.floor(
		(doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365
	)
	const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100))
	const mp = Math.floor((5 * doy + 2) / 153)
	const month = mp + (mp < 10 ? 3 : -9)
	return {
		year: yoe + era * 400 + (month <= 2 ? 1 : 0),
		month,
		day: doy - Math.floor((153 * mp + 2) / 5) + 1
	}
}

const pad = (value: number, width: number) => String(value).padStart(width, "0")

export const formatDate = (day: bigint): string => {
	const { year, month, day: d } = civil(day)
	return `${pad(year, 4)}-${pad(month, 2)}-${pad(d, 2)}`
}

export const parseDate = (text: string): bigint => {
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text)
	const day = match && dayOf(Number(match[1]), Number(match[2]), Number(match[3]))
	if (day === null || formatDate(day) !== text)
		throw new Refusal({ code: "InvalidDate", message: `Not a calendar date (YYYY-MM-DD): ${text}` })
	return day
}

/** Sunday = 0 … Saturday = 6; 1970-01-01 was a Thursday. */
export const weekday = (day: bigint): number => Number((((day + 4n) % 7n) + 7n) % 7n)

export const yearSpan = (year: number): Span => ({ start: dayOf(year, 1, 1), end: dayOf(year + 1, 1, 1) })
export const monthSpan = (year: number, month: number): Span => ({
	start: dayOf(year, month, 1),
	end: month === 12 ? dayOf(year + 1, 1, 1) : dayOf(year, month + 1, 1)
})
export const quarterSpan = (year: number, quarter: number): Span => ({
	start: monthSpan(year, quarter * 3 - 2).start,
	end: monthSpan(year, quarter * 3).end
})
export const yearOf = (day: bigint) => civil(day).year
export const quarterOf = (day: bigint) => {
	const { year, month } = civil(day)
	return quarterSpan(year, Math.ceil(month / 3))
}
export const monthOf = (day: bigint) => {
	const { year, month } = civil(day)
	return monthSpan(year, month)
}
/** The months of a span, in order. */
export const months = (span: Span): Span[] => {
	const result: Span[] = []
	for (let month = monthOf(span.start); month.start < span.end; month = monthOf(month.end)) result.push(month)
	return result
}
export const covers = (span: Span, day: bigint) => span.start <= day && day < span.end
export const sameSpan = (a: Span, b: Span) => a.start === b.start && a.end === b.end
export const point = (day: bigint): Span => ({ start: day, end: day + 1n })

/** "2026", "2026Q3" or "2026-10": a year, quarter or month. */
export const parsePeriod = (text: string): Span => {
	const year = /^(\d{4})$/.exec(text)
	if (year) return yearSpan(Number(year[1]))
	const quarter = /^(\d{4})Q([1-4])$/.exec(text)
	if (quarter) return quarterSpan(Number(quarter[1]), Number(quarter[2]))
	const month = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(text)
	if (month) return monthSpan(Number(month[1]), Number(month[2]))
	throw new Refusal({ code: "InvalidPeriod", message: `Use "2026", "2026Q3" or "2026-10": ${text}` })
}

export const formatPeriod = (span: Span): string => {
	const { year, month } = civil(span.start)
	if (sameSpan(span, yearSpan(year))) return pad(year, 4)
	if (month % 3 === 1 && sameSpan(span, quarterSpan(year, (month + 2) / 3)))
		return `${pad(year, 4)}Q${(month + 2) / 3}`
	if (sameSpan(span, monthSpan(year, month))) return `${pad(year, 4)}-${pad(month, 2)}`
	return `${formatDate(span.start)}/${formatDate(span.end)}`
}

/** Today's civil date in a named time zone. */
export const todayIn = (timeZone: string, now = new Date()): bigint =>
	parseDate(
		new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(
			now
		)
	)
