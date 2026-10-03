import assert from "node:assert/strict"
import { test } from "node:test"
import { holidays, isBusinessDay, nextBusinessDay } from "../src/calendar.ts"
import { formatDate, formatPeriod, parseDate, parsePeriod } from "../src/core/time.ts"

const roll = (day: string) => formatDate(nextBusinessDay(parseDate(day)))

test("deadlines roll past weekends and DC holidays", () => {
	assert.equal(roll("2026-11-15"), "2026-11-16") // Sunday
	assert.equal(roll("2026-10-31"), "2026-11-02") // Saturday
	assert.equal(roll("2027-01-31"), "2027-02-01") // Sunday
	assert.equal(roll("2026-02-15"), "2026-02-17") // Sunday, then Washington's Birthday
	assert.equal(roll("2026-04-16"), "2026-04-17") // DC Emancipation Day
	assert.equal(roll("2026-11-11"), "2026-11-12") // Veterans Day
	assert.equal(roll("2026-10-15"), "2026-10-15") // an ordinary Thursday
})

test("fixed holidays move to the nearest weekday", () => {
	const listed = (year: number) => holidays(year).map(formatDate)
	assert.ok(listed(2026).includes("2026-07-03")) // July 4 is a Saturday
	assert.ok(listed(2027).includes("2027-12-24")) // Christmas is a Saturday
	assert.ok(listed(2028).includes("2028-12-25"))
	assert.ok(listed(2021).includes("2021-01-20")) // Inauguration Day
	assert.ok(listed(2041).includes("2041-01-21")) // Inauguration Day on a Sunday
	assert.ok(!listed(2029).some((day) => day >= "2029-01-19" && day <= "2029-01-22")) // on a Saturday: none
	assert.ok(!isBusinessDay(parseDate("2027-12-31"))) // New Year's 2028 is a Saturday
	assert.ok(isBusinessDay(parseDate("2026-12-31")))
})

test("periods parse and print as years, quarters and months", () => {
	for (const text of ["2026", "2026Q3", "2026-10"]) assert.equal(formatPeriod(parsePeriod(text)), text)
	assert.throws(() => parsePeriod("2026Q5"), { code: "InvalidPeriod" })
	assert.throws(() => parseDate("2026-02-30"), { code: "InvalidDate" })
})
