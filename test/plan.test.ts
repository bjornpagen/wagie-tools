import assert from "node:assert/strict"
import { before, test } from "node:test"
import { parseDollars as $ } from "../src/core/boundary.ts"
import { yearSpan } from "../src/core/time.ts"
import { insert, remove } from "../src/db.ts"
import { filingId } from "../src/ops.ts"
import { commit, federal, ledger2026, op, paid, read, sendMoney, texas } from "./support.ts"

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
	const converted = (row: unknown) => (row as { converted: string }).converted
	assert.equal(converted(swept.february), "1000.00") // the January wire, not the deferral
	assert.equal(converted(swept.march), "750.00")
	assert.equal(converted(swept.april), "250.00") // at most the basis reported
	assert.deepEqual(swept.pretax, {
		outcome: "committed",
		account: "Pretax",
		on: "2026-03-15",
		gross: "2000.00",
		taxable: "2000.00",
		basis: "0.00",
		converted: "0.00"
	})
})

test("the 1099-R reports each account's way out; the after-tax conversions are implied", async () => {
	const report = await op(ledger, "report", { year: 2026 })
	const forms = report.forms as { [form: string]: { lines: { [line: string]: string | number } } }
	assert.deepEqual(forms.F1099R?.lines, {
		F1099R_Pretax_G_1: "2000.00",
		F1099R_Pretax_G_2a: "2000.00",
		F1099R_Pretax_G_2b: 0,
		F1099R_Pretax_G_5: "0.00",
		F1099R_AfterTax_G_1: "2150.00",
		F1099R_AfterTax_G_2a: "0.00",
		F1099R_AfterTax_G_2b: 0,
		F1099R_AfterTax_G_5: "2150.00",
		F1099R_Roth_H_1: "2650.00",
		F1099R_Roth_H_2a: "0.00",
		F1099R_Roth_H_2b: 0,
		F1099R_Roth_H_5: "2500.00",
		F1099R_Roth_H_10: "2000.00",
		F1099R_Roth_H_11: 2026
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

test("a 1099-R filed wrong is corrected box by box, with the 1096 that transmits it", async () => {
	const own = await ledger2026()
	await op(own, "transfer.record", {
		kind: "AfterTax",
		year: 2026,
		mercury: sendMoney(),
		sentOn: "2026-01-20",
		amount: "1000.00"
	})
	await op(own, "plan.rollover", { account: "Roth", on: "2026-02-02", gross: "1100.00" })
	await op(own, "filing.record", { form: "F1099R", period: "2026", method: "Furnished", on: "2027-01-20" })
	// As filed: the Roth sweep's earnings reported as basis, both forms marked
	// a total distribution, box 11 blank.
	const id = filingId("F1099R", yearSpan(2026))
	const wrong = {
		F1099R_AfterTax_G_2b: 1n,
		F1099R_Roth_H_2b: 1n,
		F1099R_Roth_H_5: $("1100.00"),
		F1099R_Roth_H_11: 0n
	}
	const filed = (await read(own)).FiledFigures.filter(
		(row) => row.filing === id && Object.hasOwn(wrong, row.line)
	)
	await commit(own, [
		...remove("FiledFigures", ...filed),
		...insert(
			"FiledFigures",
			...filed.map((row) => ({ ...row, value: wrong[row.line as keyof typeof wrong] }))
		)
	])
	const restated = [
		{ line: "F1099R_AfterTax_G_2b", original: 1, corrected: 0, difference: -1 },
		{ line: "F1099R_Roth_H_2b", original: 1, corrected: 0, difference: -1 },
		{ line: "F1099R_Roth_H_5", original: "1100.00", corrected: "1000.00", difference: "-100.00" },
		{ line: "F1099R_Roth_H_11", original: 0, corrected: 2026, difference: 2026 }
	]
	const transmittal = { count: 2, gross: "2100.00" }
	const mismatched = async () =>
		((await op(own, "status", { asOf: "2027-01-21" })).mismatches as { line: string; next?: string }[]).map(
			({ line, next }) => [line, next]
		)
	assert.deepEqual(await mismatched(), [
		["F1099R_AfterTax_G_2b", "filing.correct"],
		["F1099R_Roth_H_2b", "filing.correct"],
		["F1099R_Roth_H_5", "filing.correct"],
		["F1099R_Roth_H_11", "filing.correct"]
	])
	const view = async () =>
		(
			(await op(own, "report", { year: 2026 })).forms as {
				F1099R: { corrections?: object[]; correctionDue?: object }
			}
		).F1099R
	assert.deepEqual((await view()).correctionDue, { lines: restated, transmittal })

	const mailed = {
		form: "F1099R",
		period: "2026",
		mailedOn: "2027-02-10",
		tracking: "9400100000000000000009"
	}
	assert.equal((await op(own, "filing.correct", mailed)).outcome, "committed")
	assert.equal((await op(own, "filing.correct", mailed)).outcome, "no-change")
	await assert.rejects(op(own, "filing.correct", { ...mailed, tracking: "9400100000000000000010" }), {
		code: "Corrected"
	})
	assert.deepEqual(await mismatched(), [])
	const { corrections, correctionDue } = await view()
	assert.deepEqual(corrections, [
		{
			mailedOn: "2027-02-10",
			tracking: mailed.tracking,
			lines: restated,
			transmittal
		}
	])
	assert.equal(correctionDue, undefined)
})

test("an after-tax wire is converted, and reported, in the year it was sent, whatever plan year it counts toward", async () => {
	const own = await ledger2026()
	await op(own, "transfer.record", {
		kind: "AfterTax",
		year: 2026,
		mercury: sendMoney(),
		sentOn: "2027-01-08",
		amount: "500.00"
	})
	const conversion = async (year: number) =>
		((await op(own, "report", { year })).forms as { F1099R: { lines: { F1099R_AfterTax_G_1: string } } })
			.F1099R.lines.F1099R_AfterTax_G_1
	assert.equal(await conversion(2026), "0.00")
	assert.equal(await conversion(2027), "500.00")
	const due = (
		(await op(own, "status", { asOf: "2026-12-31" })).upcoming as { what: string; period: string }[]
	)
		.filter((item) => item.what === "File F1099R")
		.map((item) => item.period)
	assert.deepEqual(due, ["2027"])
})

test("box 10 counts a sweep's conversions from its year and the four before", async () => {
	const swept = async (on: string) => {
		const own = await ledger2026()
		await op(own, "transfer.record", {
			kind: "AfterTax",
			year: 2026,
			mercury: sendMoney(),
			sentOn: "2026-03-02",
			amount: "1000.00"
		})
		const sweep = await op(own, "plan.rollover", { account: "Roth", on, gross: "1500.00" })
		return [sweep.basis, sweep.converted]
	}
	assert.deepEqual(await swept("2030-12-31"), ["1000.00", "1000.00"])
	assert.deepEqual(await swept("2031-01-02"), ["1000.00", "0.00"])
})

test("box 11 dates a Roth deferral by its paycheck, however late the wire", async () => {
	const own = await ledger2026("2026-12-15")
	await op(own, "policy.set", federal(2027))
	await op(own, "policy.set", texas(2027))
	await op(own, "election.set", { year: 2027, roth: "24500.00", afterTax: "0.00", signedOn: "2026-12-15" })
	const check = await op(own, "payroll.post", {
		paidOn: "2026-12-31",
		input: { by: "gross", gross: "1000.00", roth: "100.00" }
	})
	for (const wire of check.wires as { kind: string; amount: string }[])
		await op(own, "transfer.record", {
			kind: wire.kind,
			paidOn: "2026-12-31",
			mercury: sendMoney(),
			sentOn: wire.kind === "RothDeferral" ? "2027-01-04" : "2026-12-31",
			amount: wire.amount
		})
	await op(own, "plan.rollover", { account: "Roth", on: "2027-02-01", gross: "100.00" })
	const { forms } = await op(own, "report", { year: 2027 })
	assert.equal(
		(forms as { F1099R: { lines: { F1099R_Roth_H_11: number } } }).F1099R.lines.F1099R_Roth_H_11,
		2026
	)
})

test("after-tax stays within 415(c): the year's pay, the salary target standing in", async () => {
	const own = await ledger2026()
	await op(own, "plan.set", { year: 2026, salary: "10000.00", fitPerCheck: "0.01" })
	const wire = (amount: string) =>
		op(own, "transfer.record", {
			kind: "AfterTax",
			year: 2026,
			mercury: sendMoney(),
			sentOn: "2026-01-05",
			amount
		})
	await assert.rejects(wire("10000.01"), { code: "Over415c" })
	assert.equal((await wire("10000.00")).outcome, "committed")
	assert.deepEqual((await op(own, "status", { asOf: "2026-01-05" })).afterTax, { room: "0.00" })
})

test("once the 1099-Rs are corrected, the original 1096 stands as filed", async () => {
	const own = await ledger2026()
	const afterTax = (sentOn: string, amount: string) =>
		op(own, "transfer.record", { kind: "AfterTax", year: 2026, mercury: sendMoney(), sentOn, amount })
	await afterTax("2026-03-02", "1000.00")
	await op(own, "filing.record", { form: "F1099R", period: "2026", method: "Furnished", on: "2027-01-20" })
	await op(own, "filing.record", {
		form: "F1096",
		period: "2026",
		method: "CertifiedMail",
		mailedOn: "2027-01-20",
		tracking: "9400100000000000000011"
	})
	await afterTax("2026-12-30", "500.00") // a conversion the forms missed
	const mismatched = async () =>
		((await op(own, "status", { asOf: "2027-02-03" })).mismatches as { form: string; line: string }[])
			.map(({ line }) => line)
			.sort()
	assert.deepEqual(await mismatched(), ["F1096_5", "F1099R_AfterTax_G_1", "F1099R_AfterTax_G_5"])
	await op(own, "filing.correct", {
		form: "F1099R",
		period: "2026",
		mailedOn: "2027-02-02",
		tracking: "9400100000000000000012"
	})
	assert.deepEqual(await mismatched(), [])
})

test("an after-tax contribution counts toward a year only if sent in it or 30 days after", async () => {
	const own = await ledger2026()
	const wire = (sentOn: string) =>
		op(own, "transfer.record", {
			kind: "AfterTax",
			year: 2026,
			mercury: sendMoney(),
			sentOn,
			amount: "100.00"
		})
	await assert.rejects(wire("2025-12-31"), { code: "OutsideCrediting" })
	await assert.rejects(wire("2027-01-31"), { code: "OutsideCrediting" })
	assert.equal((await wire("2027-01-30")).outcome, "committed")
})
