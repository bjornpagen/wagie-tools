import assert from "node:assert/strict"
import { test } from "node:test"
import { parseDollars as $ } from "../src/core/boundary.ts"
import { parseDate, point } from "../src/core/time.ts"
import { insert } from "../src/db.ts"
import { commit, deposit, ledger2026, op, paid, sendMoney } from "./support.ts"

type Form = {
	names: { role: string; name: string }[]
	account?: string
	lines: { [line: string]: string | number }
}
type Forms = { [form: string]: Form }
const forms = async (ledger: string, year: number, quarter?: number) =>
	(await op(ledger, "report", quarter === undefined ? { year } : { year, quarter })).forms as Forms

test("the 941 prices FICA on the quarter's totals; line 7 is the employee share's rounding", async () => {
	const ledger = await ledger2026()
	for (const paidOn of ["2026-01-09", "2026-01-16", "2026-01-23"])
		await paid(ledger, paidOn, { by: "gross", gross: "1000.05" })
	await deposit(ledger, "2026Q1", "459.04", "2026-02-10")
	const { F941, C3 } = await forms(ledger, 2026, 1)
	assert.deepEqual(F941?.lines, {
		F941_1: 1,
		F941_2: "3000.15",
		F941_3: "0.03",
		F941_5a1: "3000.15",
		F941_5a2: "372.02",
		F941_5c1: "3000.15",
		F941_5c2: "87.00",
		F941_5e: "459.02",
		F941_6: "459.05",
		F941_7: "-0.01", // withheld 229.50, the employee's share of 3,000.15 is 229.511475
		F941_10: "459.04",
		F941_12: "459.04",
		F941_13: "459.04",
		F941_14: "0.00",
		F941_15: "0.00",
		F941_16_1: "459.04", // three checks of 153.01, and the quarter's cent
		F941_16_2: "0.00",
		F941_16_3: "0.00"
	})
	assert.deepEqual(C3?.lines, {
		C3_employees_1: 1,
		C3_employees_2: 1,
		C3_employees_3: 1,
		C3_wages: "3000.15",
		C3_taxable: "3000.15",
		C3_rate: "2.7",
		C3_tax: "81.00"
	})
	assert.equal(C3?.account, "00-000000-0")
	assert.deepEqual(
		F941?.names.map((party) => party.role),
		["Employer"]
	)
})

test("the last month with a paycheck absorbs the quarter's rounding", async () => {
	const ledger = await ledger2026()
	const check = { by: "gross", gross: "100.02" }
	await paid(ledger, "2026-01-09", check)
	await deposit(ledger, "2026Q1", "15.31", "2026-02-02")
	await paid(ledger, "2026-02-06", check)
	await deposit(ledger, "2026Q1", "15.31", "2026-03-02")
	await paid(ledger, "2026-03-06", check)
	const { F941 } = await forms(ledger, 2026, 1)
	assert.equal(F941?.lines.F941_12, "45.94") // 0.03 + 37.21 + 8.70, while each check is 15.31
	assert.deepEqual(
		["F941_16_1", "F941_16_2", "F941_16_3"].map((line) => F941?.lines[line]),
		["15.31", "15.31", "15.32"]
	)
	const march = (
		(await op(ledger, "status", { asOf: "2026-04-01" })).blockers as { what: string; amount: string }[]
	)
		.filter((item) => item.what === "941 deposit")
		.map((item) => item.amount)
	assert.deepEqual(march, ["15.32"])
})

test("FUTA and Texas UI tax only the wages under their bases", async () => {
	const ledger = await ledger2026()
	for (const paidOn of ["2026-01-02", "2026-01-09", "2026-01-16", "2026-01-23", "2026-01-30"])
		await paid(ledger, paidOn, { by: "gross", gross: "2000.00" })
	const quarter = await forms(ledger, 2026, 1)
	assert.equal(quarter.C3?.lines.C3_wages, "10000.00")
	assert.equal(quarter.C3?.lines.C3_taxable, "9000.00")
	assert.equal(quarter.C3?.lines.C3_tax, "243.00")
	const year = await forms(ledger, 2026)
	assert.deepEqual(year.F940?.lines, {
		F940_3: "10000.00",
		F940_5: "3000.00",
		F940_7: "7000.00",
		F940_8: "42.00",
		F940_12: "42.00",
		F940_13: "0.00",
		F940_14: "42.00",
		F940_15: "0.00"
	})
	assert.equal(year.W2?.lines.W2_4, "620.00")
})

test("the W-2 reports Roth in box 12 AA and wages including it, naming both parties", async () => {
	const ledger = await ledger2026()
	await paid(ledger, "2026-01-09", { by: "gross", gross: "2000.00", roth: "500.00" })
	await paid(ledger, "2026-01-16", { by: "gross", gross: "2000.00", roth: "250.00" })
	const { W2, W3 } = await forms(ledger, 2026)
	assert.equal(W2?.lines.W2_1, "4000.00")
	assert.equal(W2?.lines.W2_4, "248.00")
	assert.equal(W2?.lines.W2_12AA, "750.00")
	assert.equal(W2?.lines.W2_13, 1)
	assert.equal(W3?.lines.W3_12a, "750.00")
	assert.equal(W3?.lines.W3_c, 1)
	assert.deepEqual(
		W2?.names.map((party) => [party.role, party.name]),
		[
			["Employer", "Example Farm LLC"],
			["Employee", "Pat Owner"]
		]
	)
})

test("a 941-X shows each line it restates, as filed and corrected, its tax, and line 27", async () => {
	const ledger = await ledger2026()
	await paid(ledger, "2026-01-09", { by: "gross", gross: "1000.00" })
	await deposit(ledger, "2026Q1", "153.01", "2026-02-10")
	await op(ledger, "filing.record", {
		form: "F941",
		period: "2026Q1",
		method: "CertifiedMail",
		mailedOn: "2026-04-02",
		tracking: "9400100000000000000001"
	})
	await op(ledger, "payroll.correct", { paidOn: "2026-01-09", fit: "10.01" })
	const f941 = async () =>
		((await op(ledger, "report", { year: 2026, quarter: 1 })).forms as { F941: { [key: string]: unknown } })
			.F941
	const lines = [{ line: "F941_3", original: "0.01", corrected: "10.01", difference: "10.00", tax: "10.00" }]
	assert.deepEqual((await f941()).correctionDue, { lines, line27: "10.00" })
	await op(ledger, "filing.correct", {
		form: "F941",
		period: "2026Q1",
		mailedOn: "2026-05-01",
		tracking: "9400100000000000000002"
	})
	const { corrections, correctionDue } = await f941()
	assert.deepEqual(corrections, [
		{ mailedOn: "2026-05-01", tracking: "9400100000000000000002", lines, line27: "10.00" }
	])
	assert.equal(correctionDue, undefined)
})

test("the year shows its policy, and tax payments their tracker or outside Mercury", async () => {
	const ledger = await ledger2026()
	await deposit(ledger, "2026Q1", "100.00", "2026-02-10")
	await commit(ledger, [
		...insert("History", { span: { start: parseDate("2026-01-01"), end: parseDate("2026-05-01") } }),
		...insert("TaxPayment", {
			tracker: "37834317",
			account: "TexasUI",
			kind: "Deposit",
			period: { start: parseDate("2026-01-01"), end: parseDate("2026-04-01") },
			amount: $("243.00"),
			initiatedOn: point(parseDate("2026-04-20")),
			funding: "OutsideMercury"
		})
	])
	const report = await op(ledger, "report", { year: 2026 })
	assert.deepEqual(report.policy, {
		deferralLimit: "24500.00",
		additionsLimit: "72000.00",
		compensationLimit: "360000.00",
		wageCeiling: "200000.00",
		bands: [
			{ tax: "SocialSecurity", rate: "6.2", base: "184500.00" },
			{ tax: "Medicare", rate: "1.45" },
			{ tax: "FederalUnemployment", rate: "0.6", base: "7000.00" },
			{ tax: "TexasUnemployment", rate: "2.7", base: "9000.00" }
		]
	})
	const payments = report.taxPayments as { tracker: string; mercury: string }[]
	assert.equal(payments.length, 2)
	assert.match(payments[0]?.mercury ?? "", /^\d{15}$/)
	assert.deepEqual(payments[1], {
		tracker: "37834317",
		account: "TexasUI",
		kind: "Deposit",
		period: "2026Q1",
		amount: "243.00",
		initiatedOn: "2026-04-20",
		mercury: "outside Mercury"
	})
})

test("W-2 box 13 is checked for a year with Roth deferrals or after-tax contributions", async () => {
	const ledger = await ledger2026()
	await paid(ledger, "2026-01-09", { by: "gross", gross: "1000.00" })
	const box13 = async () => (await forms(ledger, 2026)).W2?.lines.W2_13
	assert.equal(await box13(), 0)
	await op(ledger, "transfer.record", {
		kind: "AfterTax",
		year: 2026,
		mercury: sendMoney(),
		sentOn: "2026-02-02",
		amount: "100.00"
	})
	assert.equal(await box13(), 1)
})

test("a year's tax payments are those toward its periods, whenever made", async () => {
	const ledger = await ledger2026()
	await deposit(ledger, "2026Q4", "10.00", "2027-01-12")
	await deposit(ledger, "2027Q1", "20.00", "2027-02-10")
	const periods = async (year: number) =>
		((await op(ledger, "report", { year })).taxPayments as { period: string }[]).map((row) => row.period)
	assert.deepEqual(await periods(2026), ["2026Q4"])
	assert.deepEqual(await periods(2027), ["2027Q1"])
})

test("line 16 takes the quarter's rounding where no month goes below zero", async () => {
	const ledger = await ledger2026()
	// Social security and Medicare both round up on each of these.
	const january = {
		"2026-01-02": "1001.05",
		"2026-01-09": "1008.63",
		"2026-01-16": "1013.47",
		"2026-01-23": "1016.21"
	}
	for (const [paidOn, gross] of Object.entries(january)) await paid(ledger, paidOn, { by: "gross", gross })
	const due = ((await op(ledger, "status", { asOf: "2026-02-02" })).blockers as { amount: string }[])[0]
	await deposit(ledger, "2026Q1", due?.amount ?? "", "2026-02-02")
	await paid(ledger, "2026-02-06", { by: "gross", gross: "0.01" })
	const { F941 } = await forms(ledger, 2026, 1)
	const months = ["F941_16_1", "F941_16_2", "F941_16_3"].map((line) => F941?.lines[line])
	assert.deepEqual(months, ["618.10", "0.01", "0.00"])
	assert.equal(F941?.lines.F941_12, "618.11")
})
