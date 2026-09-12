import assert from "node:assert/strict"
import { test } from "node:test"
import {
	addCalendarDays,
	calendarDays,
	civilDaySpan,
	countCalendarDays,
	epochDay,
	epochMilliseconds,
	formatCalendarDate,
	localDayAt,
	parseCalendarDate,
	periodSpan,
	type UnixEpochDay,
	type UnixEpochMilliseconds
} from "../src/core/time.ts"

test("date coordinates have an explicit epoch and preserve calendar boundaries", () => {
	assert.equal(parseCalendarDate("1970-01-01"), 0n)
	assert.equal(parseCalendarDate("1969-12-31"), -1n)
	assert.equal(formatCalendarDate(epochDay(-1n)), "1969-12-31")
	assert.equal(
		formatCalendarDate(addCalendarDays(parseCalendarDate("2024-02-28"), calendarDays(1n))),
		"2024-02-29"
	)
	assert.equal(countCalendarDays(periodSpan(2024, "Year")), 366n)
	assert.equal(countCalendarDays(periodSpan(2025, "Year")), 365n)
	assert.equal(formatCalendarDate(periodSpan(2026, "Quarter", 4).end), "2027-01-01")
	assert.throws(() => parseCalendarDate("2025-02-29"))
	assert.throws(() => civilDaySpan(epochDay(1n), epochDay(1n)))
	assert.throws(() => periodSpan(2026, "Quarter", 5))
})

test("an instant's civil date is chosen in the named employer zone", () => {
	const instant = epochMilliseconds(BigInt(Date.parse("2026-09-11T00:30:00Z")))
	assert.equal(formatCalendarDate(localDayAt(instant, "America/Chicago")), "2026-09-10")
	assert.equal(formatCalendarDate(localDayAt(instant, "Asia/Tokyo")), "2026-09-11")
	const before = epochMilliseconds(BigInt(Date.parse("2026-03-08T07:59:59Z")))
	const after = epochMilliseconds(BigInt(Date.parse("2026-03-08T08:00:00Z")))
	assert.equal(localDayAt(before, "America/Chicago"), localDayAt(after, "America/Chicago"))
})

// These compile-time checks fail the build if the units become interchangeable.
function unitsRemainDistinct(day: UnixEpochDay, instant: UnixEpochMilliseconds) {
	// @ts-expect-error Unix milliseconds are not a calendar-date coordinate.
	const wrongDay: UnixEpochDay = instant
	// @ts-expect-error A calendar date does not identify a UTC instant.
	const wrongInstant: UnixEpochMilliseconds = day
	// @ts-expect-error A date coordinate cannot stand in for a day count.
	addCalendarDays(day, day)
	return { wrongDay, wrongInstant }
}
void unitsRemainDistinct
