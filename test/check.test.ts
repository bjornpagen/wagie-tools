import assert from "node:assert/strict"
import { test } from "node:test"
import { assess, type Band, nearest, netOf, price, subjectTo } from "../src/check.ts"
import { parseDollars as $, formatPercent, parsePercent } from "../src/core/boundary.ts"
import { parseDate, yearSpan } from "../src/core/time.ts"
import { MAX_U64 } from "../src/core/values.ts"
import { grossForNet, planGross, priceCheck } from "../src/gross-up.ts"

const band = (tax: Band["tax"], rate: string, base?: string): Band => ({
	year: 2026n,
	tax,
	wages: { start: 0n, end: base === undefined ? MAX_U64 : $(base) },
	rate: parsePercent(rate)
})
const bands = [
	band("SocialSecurity", "6.2", "184500.00"),
	band("Medicare", "1.45"),
	band("FederalUnemployment", "0.6", "7000.00"),
	band("TexasUnemployment", "2.7", "9000.00")
]
const year = {
	year: 2026n,
	span: yearSpan(2026),
	deferralLimit: $("24500.00"),
	additionsLimit: $("72000.00"),
	compensationLimit: $("360000.00"),
	wageCeiling: $("200000.00")
}
const plan = { year: 2026n, salary: $("120000.00"), fitPerCheck: 1n }

test("nearest rounds ties away from zero, on either side of it", () => {
	assert.equal(nearest(5n, 10n), 1n)
	assert.equal(nearest(4n, 10n), 0n)
	assert.equal(nearest(15n, 10n), 2n)
	assert.equal(nearest(-5n, 10n), -1n)
	assert.equal(nearest(-4n, 10n), 0n)
	assert.equal(nearest(-15n, 10n), -2n)
	assert.equal(nearest(-1_147_500n, 1_000_000n), -1n)
})

test("rates are percents at the boundary and parts per million inside", () => {
	assert.equal(parsePercent("6.2"), 62_000n)
	assert.equal(parsePercent("1.45"), 14_500n)
	assert.equal(parsePercent("0.6"), 6_000n)
	assert.equal(parsePercent("100"), 1_000_000n)
	for (const ppm of [62_000n, 14_500n, 6_000n, 27_000n, 1n])
		assert.equal(parsePercent(formatPercent(ppm)), ppm)
	for (const text of ["6.20001", "100.01", "-1", ".5", "06.2"])
		assert.throws(() => parsePercent(text), { code: "InvalidRate" })
})

test("a band taxes only the slice of a paycheck inside it", () => {
	const ss = { start: 0n, end: $("184500.00") }
	assert.equal(subjectTo(ss, $("184000.00"), $("1000.00")), $("500.00"))
	assert.equal(subjectTo(ss, $("185000.00"), $("1000.00")), 0n)
	const futa = { start: 0n, end: $("7000.00") }
	assert.equal(subjectTo(futa, $("6500.00"), $("1000.00")), $("500.00"))
	assert.equal(subjectTo({ start: 0n, end: $("9000.00") }, $("8500.00"), $("1000.00")), $("500.00"))
})

test("assessing a paycheck prices the employee's taxes, each rounded once", () => {
	const crossing = assess(bands, $("184000.00"), $("1000.00"))
	assert.deepEqual(
		[...crossing],
		[
			["SocialSecurity", $("31.00")],
			["Medicare", $("14.50")]
		]
	)
	assert.equal(assess(bands, $("185000.00"), $("1000.00")).get("SocialSecurity"), 0n)
	assert.equal(assess(bands, 0n, $("1000.05")).get("SocialSecurity"), $("62.00"))
	const check = price(bands, 0n, $("2000.00"), 1n, $("500.00"))
	assert.equal(netOf(check), $("1346.99"))
})

test("a net target finds the smallest gross that nets it exactly", () => {
	for (const [ytd, net] of [
		[0n, $("1000.00")],
		[$("184000.00"), $("1000.00")],
		[0n, $("1.00")]
	] as const) {
		const gross = grossForNet(bands, ytd, 1n, 0n, net)
		assert.equal(netOf(price(bands, ytd, gross, 1n, 0n)), net)
		assert.ok(netOf(price(bands, ytd, gross - 1n, 1n, 0n)) < net)
	}
})

test("the plan spreads what is left of the salary over the days left", () => {
	assert.equal(planGross(plan, year, 0n, parseDate("2026-01-09")), $("2352.94")) // 120,000.00 × 7 ÷ 357 days
	assert.equal(planGross(plan, year, $("119999.00"), parseDate("2026-12-31")), $("1.00"))
	assert.throws(() => planGross(plan, year, $("120000.00"), parseDate("2026-12-31")), {
		code: "SalaryReached"
	})
})

test("a paycheck must hold its withholding and its Roth", () => {
	const at = (gross: string, roth: string, fit = 0n) =>
		priceCheck(
			year,
			bands,
			plan,
			0n,
			parseDate("2026-01-09"),
			{ by: "gross", gross: $(gross), roth: $(roth) },
			fit
		)
	assert.equal(at("100.00", "92.35").roth, $("92.35"))
	assert.throws(() => at("100.00", "92.36"), { code: "RothTooLarge" })
	assert.throws(() => at("100.00", "0.00", $("100.00")), { code: "WithholdingExceedsGross" })
})
