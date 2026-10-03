import assert from "node:assert/strict"
import { test } from "node:test"
import { computeCheck, nearest, netOf, type Rules } from "../src/check.ts"
import { parseDollars } from "../src/core/boundary.ts"
import { parseDate, yearSpan } from "../src/core/time.ts"
import type { Facts } from "../src/db.ts"
import { figures, periodOf } from "../src/forms.ts"
import { grossForNet, planGross, priceCheck } from "../src/gross-up.ts"

const $ = parseDollars
const rules: Rules = {
	year: 2026n,
	span: yearSpan(2026),
	ssRate: 620n,
	ssBase: $("184500.00"),
	medicareRate: 145n,
	futaRate: 60n,
	futaBase: $("7000.00"),
	sutaRate: 270n,
	sutaBase: $("9000.00"),
	deferralLimit: $("24500.00"),
	additionsLimit: $("72000.00"),
	compensationLimit: $("360000.00"),
	wageCeiling: $("200000.00")
}
const plan = { year: 2026n, salary: $("120000.00"), fitPerCheck: 1n }

test("nearest rounds ties away from zero", () => {
	assert.equal(nearest(5n, 10n), 1n)
	assert.equal(nearest(4n, 10n), 0n)
	assert.equal(nearest(15n, 10n), 2n)
	assert.equal(nearest(25n, 10n), 3n)
	assert.equal(nearest(14_999n, 10_000n), 1n)
	assert.equal(nearest(5_000n, 10_000n), 1n)
	assert.equal(nearest(4_999n, 10_000n), 0n)
})

test("a paycheck crossing the SS base pays SS only on the slice under it", () => {
	const check = computeCheck(rules, $("184000.00"), $("1000.00"), 0n, 0n)
	assert.deepEqual(check.earnings, { start: $("184000.00"), end: $("185000.00") })
	assert.equal(check.ss, $("31.00")) // 500.00 × 6.2%
	assert.equal(check.medicare, $("14.50")) // all 1,000.00 × 1.45%
	const above = computeCheck(rules, $("185000.00"), $("1000.00"), 0n, 0n)
	assert.equal(above.ss, 0n)
})

test("FUTA and SUTA tax the slices under their bases, rounded once per period", () => {
	const wage = (paidOn: string, start: string, gross: string) => ({
		id: `00000000-0000-8000-8000-00000000000${paidOn.slice(-1)}` as never,
		paidOn: { start: parseDate(paidOn), end: parseDate(paidOn) + 1n },
		year: 2026n,
		...computeCheck(rules, $(start), $(gross), 0n, 0n)
	})
	const wages = [wage("2026-01-02", "0.00", "5000.00"), wage("2026-01-09", "5000.00", "5000.00")]
	const facts = { TaxYear: [rules], Wage: wages, Employment: [], TaxPayment: [] } as unknown as Facts
	const quarter = figures(
		"C3",
		periodOf(facts, { start: parseDate("2026-01-01"), end: parseDate("2026-04-01") })
	)
	assert.equal(quarter.get("C3_wages"), $("10000.00"))
	assert.equal(quarter.get("C3_taxable"), $("9000.00"))
	assert.equal(quarter.get("C3_tax"), $("243.00"))
	const year = figures("F940", periodOf(facts, yearSpan(2026)))
	assert.equal(year.get("F940_7"), $("7000.00"))
	assert.equal(year.get("F940_5"), $("3000.00"))
	assert.equal(year.get("F940_8"), $("42.00"))
})

test("the gross-up finds the smallest gross netting exactly", () => {
	for (const target of ["1000.00", "1234.56", "0.01", "7777.77"]) {
		const gross = grossForNet(rules, $("10000.00"), $("50.00"), $("100.00"), $(target))
		const check = computeCheck(rules, $("10000.00"), gross, $("50.00"), $("100.00"))
		assert.equal(netOf(check), $(target))
		assert.notEqual(netOf(computeCheck(rules, $("10000.00"), gross - 1n, $("50.00"), $("100.00"))), $(target))
	}
})

test("the plan spreads the remaining salary over the days left", () => {
	// 2026-10-09: 8,971.45 left over 84 days, paid weekly.
	const ytd = $("120000.00") - $("8971.45")
	assert.equal(planGross(plan, rules, ytd, parseDate("2026-10-09")), $("747.62"))
	// The last paycheck of the year lands exactly on the target.
	assert.equal(planGross(plan, rules, $("119000.00"), parseDate("2026-12-31")), $("1000.00"))
	assert.throws(() => planGross(plan, rules, $("120000.00"), parseDate("2026-12-31")), {
		code: "SalaryReached"
	})
})

test("a year of planned paychecks ends on the salary target", () => {
	let ytd = 0n
	for (let day = parseDate("2026-01-02"); day < parseDate("2027-01-01"); day += 7n)
		ytd += planGross(plan, rules, ytd, day)
	assert.equal(ytd, plan.salary)
})

test("a Roth the paycheck can't hold refuses with the most that fits", () => {
	const at = parseDate("2026-10-09")
	assert.throws(
		() => priceCheck(rules, plan, 0n, at, { by: "gross", gross: $("1000.00"), roth: $("1000.00") }, 0n),
		(error: { code: string; message: string }) =>
			error.code === "RothTooLarge" && error.message.includes("923.50")
	)
	const check = priceCheck(rules, plan, 0n, at, { by: "gross", gross: $("1000.00"), roth: $("923.50") }, 0n)
	assert.equal(netOf(check), 0n)
	assert.throws(() => priceCheck(rules, plan, 0n, at, { by: "gross", gross: $("10.00") }, $("10.00")), {
		code: "WithholdingExceedsGross"
	})
	assert.throws(() => priceCheck(rules, undefined, 0n, at, { by: "plan" }, 0n), { code: "PayPlanMissing" })
})
