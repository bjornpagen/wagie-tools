import assert from "node:assert/strict"
import { before, test } from "node:test"
import { ledger2026, op, paid, sendMoney } from "./support.ts"

/* The plan's books: Roth basis enters as wires and leaves in whole-account
 * sweeps. $500.00 of Roth deferral, then after-tax wires that Carry converts
 * as they settle, swept three times; and the pretax account swept once. */

let ledger: string
const afterTax = (sentOn: string, amount: string) =>
	op(ledger, "transfer.record", { kind: "AfterTax", year: 2026, mercury: sendMoney(), sentOn, amount })
const sweep = (account: string, on: string, gross: string) =>
	op(ledger, "plan.rollover", { account, on, gross })
const swept: { [on: string]: unknown } = {}

before(async () => {
	ledger = await ledger2026()
	await paid(ledger, "2026-01-09", { by: "gross", gross: "2000.00", roth: "500.00" })
	await afterTax("2026-01-20", "1000.00")
	swept.february = await sweep("Roth", "2026-02-02", "1600.00")
	await afterTax("2026-02-10", "700.00")
	await afterTax("2026-03-02", "50.00")
	swept.march = await sweep("Roth", "2026-03-02", "800.00")
	await afterTax("2026-03-10", "300.00")
	swept.pretax = await sweep("Pretax", "2026-03-15", "2000.00")
	swept.april = await sweep("Roth", "2026-04-01", "250.00")
	await afterTax("2026-04-10", "100.00")
})

test("each wire's basis leaves in the first sweep on or after the day it was sent", () => {
	const basis = (row: unknown) => (row as { basis: string }).basis
	assert.equal(basis(swept.february), "1500.00") // the deferral and the January wire
	assert.equal(basis(swept.march), "750.00") // February's wire and the one sent that day
	assert.equal(basis(swept.april), "250.00") // a loss: 300.00 carried, 250.00 reported
	assert.deepEqual(swept.pretax, {
		outcome: "committed",
		account: "Pretax",
		on: "2026-03-15",
		gross: "2000.00",
		taxable: "2000.00",
		basis: "0.00"
	})
})

test("the 1099-R reports each account's way out; the after-tax conversions are implied", async () => {
	const report = await op(ledger, "report", { year: 2026 })
	const forms = report.forms as { [form: string]: { lines: { [line: string]: string | number } } }
	assert.deepEqual(forms.F1099R?.lines, {
		F1099R_Pretax_G_1: "2000.00",
		F1099R_Pretax_G_2a: "2000.00",
		F1099R_Pretax_G_5: "0.00",
		F1099R_AfterTax_G_1: "2150.00",
		F1099R_AfterTax_G_2a: "0.00",
		F1099R_AfterTax_G_5: "2150.00",
		F1099R_Roth_H_1: "2650.00",
		F1099R_Roth_H_2a: "0.00",
		F1099R_Roth_H_5: "2500.00"
	})
	assert.deepEqual(forms.F1096?.lines, { F1096_3: 3, F1096_5: "6800.00" })
	assert.deepEqual(
		(report.sweeps as { account: string; on: string; basis: string }[]).map(({ account, on, basis }) => [
			account,
			on,
			basis
		]),
		[
			["Roth", "2026-02-02", "1500.00"],
			["Roth", "2026-03-02", "750.00"],
			["Pretax", "2026-03-15", "0.00"],
			["Roth", "2026-04-01", "250.00"]
		]
	)
})

test("basis sent since the last sweep awaits the next one", async () => {
	const status = await op(ledger, "status", { asOf: "2026-04-10" })
	assert.deepEqual(status.rothBasis, { awaiting: "100.00" })
})

test("the after-tax account is never swept by hand, and a sweep records once", async () => {
	await assert.rejects(sweep("AfterTax", "2026-05-01", "10.00"), { code: "ImpliedConversion" })
	assert.equal((await sweep("Roth", "2026-04-01", "250.00")).outcome, "no-change")
	await assert.rejects(sweep("Roth", "2026-04-01", "251.00"), { code: "LawRefused" })
})

test("plan activity makes the 1099-R and 1096 due", async () => {
	const upcoming = (await op(ledger, "status", { asOf: "2026-12-31" })).upcoming as {
		what: string
		dueOn: string
	}[]
	assert.deepEqual(
		upcoming.filter((item) => item.what === "File F1099R" || item.what === "File F1096"),
		[
			{
				what: "File F1099R",
				next: "filing.record",
				period: "2026",
				opensOn: "2027-01-01",
				dueOn: "2027-02-01"
			},
			{
				what: "File F1096",
				next: "filing.record",
				period: "2026",
				opensOn: "2027-01-01",
				dueOn: "2027-03-01"
			}
		]
	)
})
