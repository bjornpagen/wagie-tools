import assert from "node:assert/strict"
import { test } from "node:test"
import { parseDollars as $ } from "../src/core/boundary.ts"
import { parseDate, quarterSpan } from "../src/core/time.ts"
import { insert } from "../src/db.ts"
import { commit, deposit, ledger2026, op, paid, sendMoney } from "./support.ts"

type Forms = { [form: string]: { [line: string]: string | number } }

test("a quarter's 941 lines, line 7 carrying the fractions of cents", async () => {
	const ledger = await ledger2026()
	for (const paidOn of ["2026-01-09", "2026-01-16", "2026-01-23"])
		await paid(ledger, paidOn, { by: "gross", gross: "1000.05" })
	await deposit(ledger, "2026Q1", "459.03", "2026-02-10")
	const { forms, totals } = await op(ledger, "report", { year: 2026, quarter: 1 })
	assert.deepEqual((forms as Forms).F941, {
		F941_1: 1,
		F941_2: "3000.15",
		F941_3: "0.03",
		F941_5a1: "3000.15",
		F941_5a2: "372.02",
		F941_5c1: "3000.15",
		F941_5c2: "87.00",
		F941_5e: "459.02",
		F941_6: "459.05",
		F941_7: "-0.02",
		F941_10: "459.03",
		F941_12: "459.03",
		F941_13: "459.03",
		F941_14: "0.00",
		F941_15: "0.00",
		F941_16_1: "459.03",
		F941_16_2: "0.00",
		F941_16_3: "0.00"
	})
	assert.deepEqual((forms as Forms).C3, {
		C3_employees_1: 1,
		C3_employees_2: 1,
		C3_employees_3: 1,
		C3_wages: "3000.15",
		C3_taxable: "3000.15",
		C3_rate: 270,
		C3_tax: "81.00"
	})
	assert.equal((totals as { gross: string }).gross, "3000.15")
})

test("a 941-X shows the original, corrected and difference of each line", async () => {
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
	await op(ledger, "filing.amend", {
		period: "2026Q1",
		mailedOn: "2026-05-01",
		tracking: "9400100000000000000002"
	})
	const { correction } = await op(ledger, "report", { year: 2026, quarter: 1 })
	const { lines, ...mailed } = correction as { lines: { line: string }[] }
	assert.deepEqual(mailed, { mailedOn: "2026-05-01", tracking: "9400100000000000000002" })
	const line = (name: string) => lines.find((row) => row.line === name)
	assert.deepEqual(line("F941_3"), {
		line: "F941_3",
		original: "0.01",
		corrected: "10.01",
		difference: "10.00"
	})
	assert.deepEqual(line("F941_12"), {
		line: "F941_12",
		original: "153.01",
		corrected: "163.01",
		difference: "10.00"
	})
	assert.deepEqual(line("F941_2"), {
		line: "F941_2",
		original: "1000.00",
		corrected: "1000.00",
		difference: "0.00"
	})
	await assert.rejects(
		op(ledger, "filing.upgrade", {
			form: "F941",
			period: "2026Q1",
			method: "CertifiedMail",
			mailedOn: "2026-04-02",
			tracking: "9400100000000000000003"
		}),
		{ code: "NotPrior" }
	)
})

test("the W-2 reports Roth in box 12 AA and wages including it", async () => {
	const ledger = await ledger2026()
	await paid(ledger, "2026-01-09", { by: "gross", gross: "2000.00", roth: "500.00" })
	await paid(ledger, "2026-01-16", { by: "gross", gross: "2000.00", roth: "250.00" })
	const forms = (await op(ledger, "report", { year: 2026 })).forms as Forms
	assert.equal(forms.W2?.W2_1, "4000.00")
	assert.equal(forms.W2?.W2_4, "248.00")
	assert.equal(forms.W2?.W2_12AA, "750.00")
	assert.equal(forms.W2?.W2_13, 1)
	assert.equal(forms.W3?.W3_12a, "750.00")
	assert.equal(forms.W3?.W3_c, 1)
})

test("after-tax contributions imply a code G 1099-R; plan moves add their own", async () => {
	const ledger = await ledger2026()
	for (const amount of ["1000.00", "500.00"])
		await op(ledger, "transfer.record", {
			kind: "AfterTax",
			year: 2026,
			mercury: sendMoney(),
			sentOn: "2026-02-01",
			amount
		})
	await op(ledger, "transfer.record", {
		kind: "Distribution",
		mercury: sendMoney(),
		sentOn: "2026-02-02",
		amount: "8000.00"
	})
	await op(ledger, "plan.distribution", {
		year: 2026,
		account: "Roth",
		code: "H",
		gross: "2000.00",
		taxable: "0.00"
	})
	await assert.rejects(
		op(ledger, "plan.distribution", {
			year: 2026,
			account: "AfterTax",
			code: "G",
			gross: "1.00",
			taxable: "0.00"
		}),
		{ code: "ImpliedConversion" }
	)
	const report = await op(ledger, "report", { year: 2026 })
	const forms = report.forms as Forms
	assert.deepEqual(forms.F1099R, {
		F1099R_AfterTax_G_1: "1500.00",
		F1099R_AfterTax_G_2a: "0.00",
		F1099R_AfterTax_G_5: "1500.00",
		F1099R_Roth_H_1: "2000.00",
		F1099R_Roth_H_2a: "0.00"
	})
	assert.deepEqual(forms.F1096, { F1096_3: 2, F1096_5: "3500.00" })
	assert.equal((report.distributions as { amount: string }).amount, "9500.00")
})

test("tax payments list their tracker and Tracking ID, or outside Mercury", async () => {
	const ledger = await ledger2026()
	await deposit(ledger, "2026Q1", "100.00", "2026-02-10")
	await commit(ledger, [
		...insert("TaxPayment", {
			tracker: "37834317",
			account: "TexasUI",
			kind: "Deposit",
			period: quarterSpan(2026, 1),
			amount: $("243.00"),
			initiatedOn: parseDate("2026-04-20"),
			funding: "OutsideMercury"
		}),
		...insert("OutsideMercury", { payment: "37834317", legacy: "TWC_37834317" })
	])
	const payments = (await op(ledger, "report", { year: 2026 })).taxPayments as {
		tracker: string
		mercury: string
	}[]
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
