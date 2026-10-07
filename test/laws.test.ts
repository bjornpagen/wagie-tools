import assert from "node:assert/strict"
import { before, test } from "node:test"
import type { Uuid } from "@bjornpagen/bumbledb"
import { parseDollars as $ } from "../src/core/boundary.ts"
import { parseDate, point, quarterSpan, yearSpan } from "../src/core/time.ts"
import { MAX_U64, naturalId } from "../src/core/values.ts"
import { type Edit, insert, remove } from "../src/db.ts"
import { filingId, wageId } from "../src/ops.ts"
import { formLines, type LineHandle, type TaxHandle } from "../src/schema.ts"
import { achTrace, commit, judge, ledger2026, op, paid, read, sendMoney } from "./support.ts"

/* Each case judges one bad change against a valid ledger; nothing commits. */

let ledger: string
let wage: Uuid
let netPay: string
const c3 = filingId("C3", quarterSpan(2026, 1))
const f941 = filingId("F941", quarterSpan(2026, 1))
const attested = filingId("F941", quarterSpan(2025, 2))
const figuresOf = (filing: Uuid, lines: readonly LineHandle[]) =>
	insert("FiledFigures", ...lines.map((line) => ({ filing, line, value: 0n })))

before(async () => {
	ledger = await ledger2026()
	await paid(ledger, "2026-01-09", { by: "gross", gross: "2000.00", roth: "500.00" })
	await op(ledger, "filing.record", {
		form: "C3",
		period: "2026Q1",
		method: "Electronic",
		on: "2026-04-02",
		confirmation: "1"
	})
	await op(ledger, "filing.record", {
		form: "F941",
		period: "2026Q1",
		method: "CertifiedMail",
		mailedOn: "2026-04-02",
		tracking: "9400100000000000000001"
	})
	await commit(ledger, [
		...insert("History", { span: yearSpan(2025) }),
		...insert("Filing", { id: attested, form: "F941", period: quarterSpan(2025, 2), method: "Attested" }),
		...figuresOf(attested, formLines.F941),
		...insert("TaxPayment", {
			tracker: "37834317",
			account: "TexasUI",
			kind: "Deposit",
			period: quarterSpan(2025, 3),
			amount: $("243.00"),
			initiatedOn: point(parseDate("2025-10-20")),
			funding: "OutsideMercury"
		})
	])
	const facts = await read(ledger)
	wage = facts.Wage[0]?.id ?? assert.fail("no wage")
	netPay = facts.NetPay[0]?.transfer ?? assert.fail("no net pay")
})

const refuses = async (edits: readonly Edit[], kind: "functionality" | "containment" | "capacity") => {
	const laws = await judge(ledger, edits)
	assert.notEqual(laws, "admitted")
	assert.match(laws, new RegExp(`^${kind}:`, "m"), laws)
}
/** A paycheck and its federal withholdings. */
const paycheck = (
	paidOn: string,
	gross: string,
	roth = "0.00",
	taxes: readonly TaxHandle[] = ["FIT", "SocialSecurity", "Medicare"],
	year = 2026n
) => {
	const id = wageId(parseDate(paidOn))
	return [
		...insert("Wage", { id, paidOn: point(parseDate(paidOn)), year, gross: $(gross), roth: $(roth) }),
		...insert("Withholding", ...taxes.map((tax) => ({ wage: id, tax, amount: 0n })))
	]
}
const transfer = (
	kind: "NetPay" | "RothDeferral" | "AfterTax" | "Distribution" | "Tax",
	mercury = sendMoney()
) => insert("Transfer", { mercury, sentOn: parseDate("2026-01-20"), kind })
const payment = (tracker: string, funding: "Mercury" | "OutsideMercury" = "Mercury", on = "2026-01-20") =>
	insert("TaxPayment", {
		tracker,
		account: "Federal941",
		kind: "Deposit",
		period: quarterSpan(2026, 1),
		amount: $("100.00"),
		initiatedOn: point(parseDate(on)),
		funding
	})

test("the valid ledger admits a valid change", async () => {
	assert.equal(await judge(ledger, paycheck("2026-01-16", "1000.00")), "admitted")
})

test("one employer, one employee, one plan, each with its own TIN", async () => {
	const employer = { role: "Employer" as const, name: "Another LLC", tin: "00-0000009", address: "x" }
	await refuses(insert("Party", employer), "functionality")
	const [owner] = (await read(ledger)).Party.filter((row) => row.role === "Employee")
	await refuses(
		[
			...remove("Party", owner ?? assert.fail("no employee")),
			...insert("Party", { role: "Employee", name: "Twin", tin: "00-0000001", address: "x" })
		],
		"functionality"
	)
})

test("registered only with states, and wherever the owner works", async () => {
	await refuses(insert("Registration", { state: "Federal", number: "1" }), "containment")
	const [registration] = (await read(ledger)).Registration
	await refuses(remove("Registration", registration ?? assert.fail("no registration")), "containment")
})

test("one paycheck per day", () =>
	refuses(
		insert("Wage", {
			id: naturalId("another"),
			paidOn: point(parseDate("2026-01-09")),
			year: 2026n,
			gross: 1n,
			roth: 0n
		}),
		"functionality"
	))

test("a paycheck is paid during employment, in its year, under an election", async () => {
	await refuses(paycheck("2026-01-01", "100.00"), "containment")
	await refuses(paycheck("2026-01-16", "100.00", "0.00", undefined, 2027n), "containment")
	const [election] = (await read(ledger)).Election
	await refuses(remove("Election", election ?? assert.fail("no election")), "containment")
})

test("a paycheck pays at least a cent, never more Roth than gross", async () => {
	await refuses(paycheck("2026-01-16", "0.00"), "capacity")
	await refuses(paycheck("2026-01-16", "100.00", "100.01"), "capacity")
	assert.equal(await judge(ledger, paycheck("2026-01-16", "100.00", "100.00")), "admitted")
})

test("Roth stays within the election, the election within 402(g)", async () => {
	await refuses(paycheck("2026-01-16", "30000.00", "24000.01"), "capacity")
	const [election] = (await read(ledger)).Election
	const old = election ?? assert.fail("no election")
	await refuses(
		[...remove("Election", old), ...insert("Election", { ...old, roth: $("24500.01") })],
		"capacity"
	)
})

test("after-tax stays within the election", async () => {
	const mercury = sendMoney()
	await refuses(
		[
			...transfer("AfterTax", mercury),
			...insert("AfterTax", { transfer: mercury, year: 2026n, amount: $("47500.01") })
		],
		"capacity"
	)
})

test("elections together stay within 415(c)", () =>
	assert.rejects(
		op(ledger, "election.set", {
			year: 2026,
			roth: "24500.00",
			afterTax: "47500.01",
			signedOn: "2026-01-02"
		}),
		{ code: "Over415c" }
	))

test("a year's wages stay under the ceiling", () => refuses(paycheck("2026-01-16", "198000.01"), "capacity"))

test("every paycheck withholds each federal employee tax exactly once, and no employer tax", async () => {
	await refuses(paycheck("2026-01-16", "100.00", "0.00", ["FIT", "SocialSecurity"]), "capacity")
	await refuses(insert("Withholding", { wage, tax: "FederalUnemployment", amount: 0n }), "containment")
	await refuses(insert("Withholding", { wage, tax: "FIT", amount: 2n }), "functionality")
})

test("every year prices each federal banded tax exactly once, and never FIT", async () => {
	const band = (tax: "SocialSecurity" | "FIT", year = 2026n) => ({
		year,
		tax,
		wages: { start: 0n, end: MAX_U64 },
		rate: 1n
	})
	await refuses(insert("TaxBand", band("SocialSecurity")), "functionality")
	await refuses(insert("TaxBand", band("FIT")), "containment")
	await refuses(insert("TaxBand", band("SocialSecurity", 2027n)), "containment")
	const medicare = (await read(ledger)).TaxBand.find((row) => row.tax === "Medicare")
	await refuses(remove("TaxBand", medicare ?? assert.fail("no Medicare band")), "capacity")
})

test("Roth wires never exceed the paycheck's Roth", async () => {
	const mercury = sendMoney()
	await refuses(
		[
			...transfer("RothDeferral", mercury),
			...insert("RothDeferral", { transfer: mercury, wage, amount: 1n })
		],
		"capacity"
	)
})

test("every transfer has exactly its one arm", async () => {
	await refuses(transfer("Distribution"), "containment")
	await refuses(insert("Distribution", { transfer: sendMoney(), amount: 1n }), "containment")
	const mercury = sendMoney()
	await refuses(
		[...transfer("Distribution", mercury), ...insert("NetPay", { transfer: mercury, wage, amount: 1n })],
		"containment"
	)
})

test("money out is never zero", async () => {
	const mercury = sendMoney()
	await refuses(
		[...transfer("Distribution", mercury), ...insert("Distribution", { transfer: mercury, amount: 0n })],
		"capacity"
	)
})

test("a Tracking ID names one transfer", () =>
	refuses(
		insert("Transfer", { mercury: netPay, sentOn: parseDate("2026-01-10"), kind: "NetPay" }),
		"functionality"
	))

test("a Mercury payment has exactly one debit; history's may have none", async () => {
	await refuses(payment("270000000000001"), "containment")
	const [first, second] = [achTrace(), achTrace()]
	await refuses(
		[
			...payment("270000000000002"),
			...transfer("Tax", first),
			...insert("TaxDebit", { transfer: first, payment: "270000000000002" }),
			...transfer("Tax", second),
			...insert("TaxDebit", { transfer: second, payment: "270000000000002" })
		],
		"functionality"
	)
	assert.equal(await judge(ledger, payment("39613547", "OutsideMercury", "2025-07-03")), "admitted")
	await refuses(payment("39613548", "OutsideMercury"), "containment")
})

test("a form is filed only as its rules allow, with every line of it", async () => {
	const id = filingId("F941", quarterSpan(2026, 2))
	const filing = (method: "Electronic" | "Furnished") =>
		insert("Filing", { id, form: "F941", period: quarterSpan(2026, 2), method })
	await refuses(
		[
			...filing("Electronic"),
			...insert("Electronic", { filing: id, on: parseDate("2026-07-02"), confirmation: "1" }),
			...figuresOf(id, formLines.F941)
		],
		"containment"
	)
	await refuses(
		[
			...filing("Furnished"),
			...insert("Furnished", { filing: id, on: parseDate("2026-07-02") }),
			...figuresOf(id, formLines.F941)
		],
		"containment"
	)
	const mailed = [
		...insert("Filing", { id, form: "F941", period: quarterSpan(2026, 2), method: "CertifiedMail" }),
		...insert("CertifiedMail", { filing: id, mailedOn: parseDate("2026-07-02"), tracking: "9400" })
	]
	assert.equal(await judge(ledger, [...mailed, ...figuresOf(id, formLines.F941)]), "admitted")
	await refuses([...mailed, ...figuresOf(id, formLines.F941.slice(1))], "capacity")
	await refuses([...mailed, ...figuresOf(id, [...formLines.F941.slice(1), "C3_tax"])], "containment")
})

test("only history is attested", async () => {
	const id = filingId("F941", quarterSpan(2026, 2))
	await refuses(
		[
			...insert("Filing", { id, form: "F941", period: quarterSpan(2026, 2), method: "Attested" }),
			...figuresOf(id, formLines.F941)
		],
		"containment"
	)
})

test("one filing per form and period", () =>
	refuses(
		[
			...insert("Filing", {
				id: naturalId("twin"),
				form: "C3",
				period: quarterSpan(2026, 1),
				method: "Electronic"
			}),
			...insert("Electronic", { filing: naturalId("twin"), on: parseDate("2026-04-03"), confirmation: "2" }),
			...figuresOf(naturalId("twin"), formLines.C3)
		],
		"functionality"
	))

test("each correction restates at least one correctable line of the return it corrects", async () => {
	const may1 = parseDate("2026-05-01")
	const correction = (filing: Uuid, mailedOn = may1) =>
		insert("Correction", { filing, mailedOn, tracking: "9400" })
	const restated = (filing: Uuid, lines: readonly LineHandle[], mailedOn = may1) =>
		insert("CorrectedFigures", ...lines.map((line) => ({ filing, mailedOn, line, value: 1n })))
	await refuses([...correction(f941), ...restated(f941, ["F941_12"])], "containment")
	await refuses([...correction(f941), ...restated(f941, ["F1099R_Roth_H_5"])], "containment")
	await refuses([...correction(f941), ...restated(f941, ["F941_3"], parseDate("2026-05-02"))], "containment")
	await refuses(correction(f941), "capacity")
	assert.equal(await judge(ledger, [...correction(f941), ...restated(f941, ["F941_3"])]), "admitted")
	assert.equal(await judge(ledger, [...correction(c3), ...restated(c3, ["C3_tax"])]), "admitted")
	const june1 = parseDate("2026-06-01")
	assert.equal(
		await judge(ledger, [
			...correction(f941),
			...restated(f941, ["F941_3"]),
			...correction(f941, june1),
			...restated(f941, ["F941_3"], june1)
		]),
		"admitted"
	)
	const r = filingId("F1099R", yearSpan(2025))
	assert.equal(
		await judge(ledger, [
			...insert("Filing", { id: r, form: "F1099R", period: yearSpan(2025), method: "Attested" }),
			...figuresOf(r, formLines.F1099R),
			...correction(r),
			...restated(r, ["F1099R_Roth_H_5", "F1099R_Roth_H_11"])
		]),
		"admitted"
	)
})

test("a rollover moves something; a carried wire is an after-tax wire, carried once, by an after-tax rollover", async () => {
	const on = parseDate("2026-02-02")
	const sweep = (account: "Pretax" | "AfterTax" | "Roth", gross: bigint, day = on) =>
		insert("Rollover", { account, on: day, gross })
	await refuses(sweep("Roth", 0n), "capacity")
	assert.equal(await judge(ledger, sweep("Roth", 100n)), "admitted")
	const mercury = sendMoney()
	const wire = [
		...transfer("AfterTax", mercury),
		...insert("AfterTax", { transfer: mercury, year: 2026n, amount: $("100.00") })
	]
	const carried = (account: "AfterTax" | "Roth", transfer = mercury, day = on) =>
		insert("Carried", { transfer, account, on: day })
	assert.equal(
		await judge(ledger, [...wire, ...sweep("AfterTax", $("100.00")), ...carried("AfterTax")]),
		"admitted"
	)
	await refuses([...sweep("AfterTax", $("100.00")), ...carried("AfterTax", netPay)], "containment")
	await refuses([...wire, ...carried("AfterTax")], "containment")
	await refuses([...wire, ...sweep("Roth", $("100.00")), ...carried("Roth")], "containment")
	await refuses(
		[
			...wire,
			...sweep("AfterTax", $("100.00")),
			...sweep("AfterTax", $("100.00"), parseDate("2026-02-03")),
			...carried("AfterTax"),
			...carried("AfterTax", mercury, parseDate("2026-02-03"))
		],
		"functionality"
	)
})

test("a recovery names real paychecks", () =>
	refuses(insert("Recovery", { wage: naturalId("nobody"), recoveredBy: wage, amount: 1n }), "containment"))
