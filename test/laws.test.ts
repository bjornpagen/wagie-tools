import assert from "node:assert/strict"
import { before, test } from "node:test"
import { parseDollars as $ } from "../src/core/boundary.ts"
import { parseDate, point, quarterSpan, yearSpan } from "../src/core/time.ts"
import { naturalId } from "../src/core/values.ts"
import { type Edit, insert, remove } from "../src/db.ts"
import { filingId, wageId } from "../src/ops.ts"
import { achTrace, commit, judge, ledger2026, op, paid, read, sendMoney } from "./support.ts"

/* Each case judges one bad change against a valid ledger; nothing commits. */

let ledger: string
let wage: { id: ReturnType<typeof wageId> }
let netPay: string
const c3 = filingId("C3", quarterSpan(2026, 1))
const f941 = filingId("F941", quarterSpan(2026, 1))
const prior = filingId("F941", quarterSpan(2025, 2))

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
		...insert("Filing", { id: prior, form: "F941", period: quarterSpan(2025, 2), method: "Prior" }),
		...insert("Prior", { filing: prior, legacy: "F941_2025Q2" }),
		...insert("TaxPayment", {
			tracker: "37834317",
			account: "TexasUI",
			kind: "Deposit",
			period: quarterSpan(2025, 3),
			amount: $("243.00"),
			initiatedOn: parseDate("2025-10-20"),
			funding: "OutsideMercury"
		}),
		...insert("OutsideMercury", { payment: "37834317", legacy: "TWC_37834317" })
	])
	const facts = await read(ledger)
	wage = facts.Wage[0] ?? assert.fail("no wage")
	netPay = facts.NetPay[0]?.transfer ?? assert.fail("no net pay")
})

const refuses = async (edits: readonly Edit[], kind: "functionality" | "containment" | "capacity") => {
	const laws = await judge(ledger, edits)
	assert.notEqual(laws, "admitted")
	assert.match(laws, new RegExp(`^${kind}:`, "m"), laws)
}
const wageRow = (paidOn: string, start: string, end: string, roth = "0.00") => ({
	id: wageId(parseDate(paidOn)),
	paidOn: point(parseDate(paidOn)),
	year: 2026n,
	earnings: { start: $(start), end: $(end) },
	fit: 0n,
	ss: 0n,
	medicare: 0n,
	roth: $(roth)
})
const transfer = (
	kind: "NetPay" | "RothDeferral" | "AfterTax" | "Distribution" | "Tax",
	mercury = sendMoney()
) => insert("Transfer", { mercury, sentOn: parseDate("2026-01-20"), kind })
const payment = (tracker: string, funding: "Mercury" | "OutsideMercury" = "Mercury") =>
	insert("TaxPayment", {
		tracker,
		account: "Federal941",
		kind: "Deposit",
		period: quarterSpan(2026, 1),
		amount: $("100.00"),
		initiatedOn: parseDate("2026-01-20"),
		funding
	})

test("the valid ledger admits a valid change", async () => {
	assert.equal(await judge(ledger, insert("Wage", wageRow("2026-01-16", "2000.00", "3000.00"))), "admitted")
})

test("one paycheck per day", () =>
	refuses(
		insert("Wage", { ...wageRow("2026-01-09", "2000.00", "3000.00"), id: naturalId("another") }),
		"functionality"
	))

test("earnings never overlap", () =>
	refuses(insert("Wage", wageRow("2026-01-16", "1999.99", "3000.00")), "functionality"))

test("a paycheck is paid during employment, in its year, under an election", async () => {
	await refuses(insert("Wage", wageRow("2026-01-01", "2000.00", "2100.00")), "containment")
	await refuses(
		insert("Wage", { ...wageRow("2026-01-16", "2000.00", "3000.00"), year: 2027n }),
		"containment"
	)
	const [election] = (await read(ledger)).Election
	await refuses(remove("Election", election ?? assert.fail("no election")), "containment")
})

test("Roth stays within the election, the election within 402(g)", async () => {
	await refuses(insert("Wage", wageRow("2026-01-16", "2000.00", "30000.00", "24000.01")), "capacity")
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
		{
			code: "Over415c"
		}
	))

test("a year's wages stay under the ceiling", () =>
	refuses(insert("Wage", wageRow("2026-01-16", "2000.00", "200000.01")), "capacity"))

test("Roth wires never exceed the paycheck's Roth", async () => {
	const mercury = sendMoney()
	await refuses(
		[
			...transfer("RothDeferral", mercury),
			...insert("RothDeferral", { transfer: mercury, wage: wage.id, amount: 1n })
		],
		"capacity"
	)
})

test("every transfer has exactly its one arm", async () => {
	await refuses(transfer("Distribution"), "containment")
	await refuses(insert("Distribution", { transfer: sendMoney(), amount: 1n }), "containment")
	const mercury = sendMoney()
	await refuses(
		[
			...transfer("Distribution", mercury),
			...insert("NetPay", { transfer: mercury, wage: wage.id, amount: 1n })
		],
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

test("every tax payment is funded by exactly one debit or a legacy row", async () => {
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
})

test("no op can grow the legacy sets", async () => {
	await refuses(
		[
			...payment("39613547", "OutsideMercury"),
			...insert("OutsideMercury", { payment: "39613547", legacy: "TWC_37834317" })
		],
		"functionality"
	)
	const another = filingId("F941", quarterSpan(2025, 3))
	await refuses(
		[
			...insert("Filing", { id: another, form: "F941", period: quarterSpan(2025, 3), method: "Prior" }),
			...insert("Prior", { filing: another, legacy: "F941_2025Q2" })
		],
		"functionality"
	)
})

test("a form is filed only as its rules allow, with every line", async () => {
	const id = filingId("F941", quarterSpan(2026, 2))
	await refuses(
		[
			...insert("Filing", { id, form: "F941", period: quarterSpan(2026, 2), method: "Electronic" }),
			...insert("Electronic", { filing: id, on: parseDate("2026-07-02"), confirmation: "1" }),
			...insert("FiledFigures", { filing: id, line: "F941_2", value: 1n })
		],
		"containment"
	)
	await refuses(
		[
			...insert("Filing", { id, form: "F941", period: quarterSpan(2026, 2), method: "Furnished" }),
			...insert("Furnished", { filing: id, on: parseDate("2026-07-02") }),
			...insert("FiledFigures", { filing: id, line: "F941_2", value: 1n })
		],
		"containment"
	)
	const w2 = filingId("W2", yearSpan(2026))
	await refuses(
		[
			...insert("Filing", { id: w2, form: "W2", period: yearSpan(2026), method: "Furnished" }),
			...insert("Furnished", { filing: w2, on: parseDate("2027-01-20") })
		],
		"capacity"
	)
	await refuses(insert("FiledFigures", { filing: prior, line: "F941_2", value: 1n }), "capacity")
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
			...insert("FiledFigures", { filing: naturalId("twin"), line: "C3_tax", value: 1n })
		],
		"functionality"
	))

test("a 941-X corrects a 941, with 941 lines", async () => {
	const correction = (filing: typeof c3) =>
		insert("Correction", { filing, mailedOn: parseDate("2026-05-01"), tracking: "9400" })
	await refuses(
		[...correction(c3), ...insert("CorrectedFigures", { filing: c3, line: "F941_2", value: 1n })],
		"containment"
	)
	await refuses(
		[...correction(f941), ...insert("CorrectedFigures", { filing: f941, line: "C3_tax", value: 1n })],
		"containment"
	)
	await refuses(correction(f941), "capacity")
	assert.equal(
		await judge(ledger, [
			...correction(f941),
			...insert("CorrectedFigures", { filing: f941, line: "F941_2", value: 1n })
		]),
		"admitted"
	)
})

test("a recovery names real paychecks", () =>
	refuses(insert("Recovery", { wage: naturalId("nobody"), recoveredBy: wage.id, amount: 1n }), "containment"))
