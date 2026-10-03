import { civil, dayOf, monthSpan, weekday } from "./core/time.ts"

/* Deadlines roll past weekends and the legal holidays in the District of
 * Columbia (IRC §7503): the federal holidays plus DC Emancipation Day and, every
 * fourth year, Inauguration Day. A fixed-date holiday on a Saturday is observed
 * the Friday before, on a Sunday the Monday after. */

const MONDAY = 1
const THURSDAY = 4

const observed = (day: bigint) => {
	const week = weekday(day)
	return week === 6 ? day - 1n : week === 0 ? day + 1n : day
}
const nth = (year: number, month: number, week: number, n: number) => {
	const first = dayOf(year, month, 1)
	return first + BigInt(((week - weekday(first) + 7) % 7) + (n - 1) * 7)
}
const last = (year: number, month: number, week: number) => {
	const end = dayOf(year, month + 1, 1) - 1n
	return end - BigInt((weekday(end) - week + 7) % 7)
}
const inauguration = (year: number): bigint[] => {
	if (year % 4 !== 1) return []
	const day = dayOf(year, 1, 20)
	return weekday(day) === 6 ? [] : weekday(day) === 0 ? [day + 1n] : [day]
}

export const holidays = (year: number): readonly bigint[] => [
	observed(dayOf(year, 1, 1)),
	nth(year, 1, MONDAY, 3),
	...inauguration(year),
	nth(year, 2, MONDAY, 3),
	observed(dayOf(year, 4, 16)),
	last(year, 5, MONDAY),
	observed(dayOf(year, 6, 19)),
	observed(dayOf(year, 7, 4)),
	nth(year, 9, MONDAY, 1),
	nth(year, 10, MONDAY, 2),
	observed(dayOf(year, 11, 11)),
	nth(year, 11, THURSDAY, 4),
	observed(dayOf(year, 12, 25))
]

/** New Year's Day on a Saturday is observed on December 31 of the year before. */
export const isBusinessDay = (day: bigint) => {
	const week = weekday(day)
	const { year } = civil(day)
	return week !== 0 && week !== 6 && !holidays(year).includes(day) && !holidays(year + 1).includes(day)
}

export const nextBusinessDay = (day: bigint): bigint => {
	let candidate = day
	while (!isBusinessDay(candidate)) candidate += 1n
	return candidate
}

/** The rosters' one due rule: the next business day on or after day `dueDay`
 * (clamped to the month's length) of the month `dueOffset` months after the
 * month holding the last day of a period ending (exclusive) at `end`. */
export const dueOn = (end: bigint, dueDay: bigint, dueOffset: bigint): bigint => {
	const last = civil(end - 1n)
	const index = last.year * 12 + last.month - 1 + Number(dueOffset)
	const month = monthSpan(Math.floor(index / 12), (index % 12) + 1)
	return nextBusinessDay(
		month.start + (dueDay < month.end - month.start ? dueDay : month.end - month.start) - 1n
	)
}
