import assert from "node:assert/strict"
import { test } from "node:test"
import { dueOn, holidays, isBusinessDay, nextBusinessDay } from "../src/calendar.ts"
import { formatDate, formatPeriod, parseDate, parsePeriod } from "../src/core/time.ts"
import { Form, TaxAccount } from "../src/schema.ts"

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

test("the rosters' one due rule", () => {
	const due = (period: string, rules: { dueDay: bigint; dueOffset: bigint }) =>
		formatDate(dueOn(parsePeriod(period).end, rules.dueDay, rules.dueOffset))
	assert.equal(due("2026-10", TaxAccount.axioms.Federal941), "2026-11-16") // the 15th is a Sunday
	assert.equal(due("2026-01", TaxAccount.axioms.Federal941), "2026-02-17") // then Washington's Birthday
	assert.equal(due("2026Q3", Form.axioms.F941), "2026-11-02") // October 31 is a Saturday
	assert.equal(due("2026Q3", TaxAccount.axioms.TexasUI), "2026-11-02")
	assert.equal(due("2026Q1", Form.axioms.C3), "2026-04-30")
	assert.equal(due("2026", Form.axioms.W2), "2027-02-01") // January 31 is a Sunday
	assert.equal(due("2026", TaxAccount.axioms.Federal940), "2027-02-01")
	assert.equal(due("2026", Form.axioms.F1096), "2027-03-01") // February 28 is a Sunday
	assert.equal(due("2027", Form.axioms.F1096), "2028-02-28")
	assert.equal(due("2026Q4", Form.axioms.F941), "2027-02-01")
	assert.equal(due("2026-02", { dueDay: 31n, dueOffset: 0n }), "2026-03-02") // clamped to the 28th, a Saturday
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
