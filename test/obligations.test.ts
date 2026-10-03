import assert from "node:assert/strict"
import { test } from "node:test"
import { parseDollars as $ } from "../src/core/boundary.ts"
import { parseDate, quarterSpan } from "../src/core/time.ts"
import { insert, remove } from "../src/db.ts"
import { filingId } from "../src/ops.ts"
import type { LineHandle } from "../src/schema.ts"
import { commit, deposit, federal, ledger2026, op, paid, read, sendMoney, texas, whats } from "./support.ts"

/* Payroll is blocked by whatever is open as of its day: wires, deposits,
 * balances, filings and corrections. Synthetic 2026 ledgers throughout; a
 * $2,000.00 paycheck with $500.00 Roth nets $1,346.99 and owes $306.01 of 941
 * tax (FIT 0.01, SS 124.00 × 2, Medicare 29.00 × 2). */

const status = (ledger: string, asOf: string) => op(ledger, "status", { asOf })
const blockers = async (ledger: string, asOf: string) => whats((await status(ledger, asOf)).blockers)
const check = { by: "gross", gross: "2000.00", roth: "500.00" }
const certified = { method: "CertifiedMail", mailedOn: "2026-04-02" }

test("unsent wires block payroll until recorded", async () => {
	const ledger = await ledger2026()
	const posted = await op(ledger, "payroll.post", { paidOn: "2026-01-09", input: check })
	assert.equal(posted.net, "1346.99")
	assert.deepEqual(await blockers(ledger, "2026-01-09"), ["Send net pay", "Send Roth to Carry"])
	await assert.rejects(op(ledger, "payroll.post", { paidOn: "2026-01-16", input: check }), {
		code: "PayrollBlocked"
	})
	const quote = await op(ledger, "payroll.quote", { paidOn: "2026-01-16", input: check })
	assert.deepEqual(whats(quote.blockers), ["Send net pay", "Send Roth to Carry"])
	const wire = { paidOn: "2026-01-09", sentOn: "2026-01-09" }
	await op(ledger, "transfer.record", { kind: "NetPay", ...wire, mercury: sendMoney(), amount: "1346.99" })
	assert.deepEqual(await blockers(ledger, "2026-01-16"), ["Send Roth to Carry"])
	await assert.rejects(
		op(ledger, "transfer.record", { kind: "RothDeferral", ...wire, mercury: sendMoney(), amount: "500.01" }),
		{ code: "Overpaid" }
	)
	await op(ledger, "transfer.record", {
		kind: "RothDeferral",
		...wire,
		mercury: sendMoney(),
		amount: "500.00"
	})
	assert.deepEqual(await blockers(ledger, "2026-01-16"), [])
})

type Item = { what: string; period?: string; dueOn?: string }
const due = (report: { blockers?: unknown; upcoming?: unknown }, what: string, period: string) =>
	[...(report.blockers as Item[]), ...(report.upcoming as Item[])].find(
		(item) => item.what === what && item.period === period
	)?.dueOn

test("a month's deposit opens when the month ends", async () => {
	const ledger = await ledger2026()
	await paid(ledger, "2026-01-09", check)
	const january = await status(ledger, "2026-01-31")
	assert.deepEqual(january.blockers, [])
	assert.deepEqual((january.upcoming as Item[])[0], {
		what: "941 deposit",
		next: "tax.paid",
		period: "2026-01",
		amount: "306.01",
		opensOn: "2026-02-01",
		dueOn: "2026-02-17"
	})
	assert.deepEqual(await blockers(ledger, "2026-02-01"), ["941 deposit"])
})

test("deadlines roll to the next business day", async () => {
	const ledger = await ledger2026("2026-09-28")
	await paid(ledger, "2026-09-30", check)
	await deposit(ledger, "2026Q3", "306.01", "2026-10-01")
	await deposit(ledger, "2026Q3", "54.00", "2026-10-01", "TexasUI")
	assert.equal(due(await status(ledger, "2026-10-01"), "File F941", "2026Q3"), "2026-11-02")
	await op(ledger, "filing.record", {
		form: "F941",
		period: "2026Q3",
		...certified,
		tracking: "9400100000000000000001"
	})
	await op(ledger, "filing.record", {
		form: "C3",
		period: "2026Q3",
		method: "Electronic",
		on: "2026-10-01",
		confirmation: "1"
	})
	await paid(ledger, "2026-10-02", check)
	const october = await status(ledger, "2026-10-03")
	assert.deepEqual(october.blockers, [])
	assert.equal(due(october, "941 deposit", "2026-10"), "2026-11-16")
	assert.equal(due(october, "File F941", "2026Q4"), "2027-02-01")
	assert.equal(due(october, "File W2", "2026"), "2027-02-01")
})

test("filing a 941 never clears an unpaid deposit; a penalty never pays tax", async () => {
	const ledger = await ledger2026()
	await paid(ledger, "2026-01-09", check)
	await op(ledger, "filing.record", {
		form: "F941",
		period: "2026Q1",
		...certified,
		tracking: "9400100000000000000001"
	})
	assert.ok((await blockers(ledger, "2026-04-02")).includes("941 deposit"))
	await op(ledger, "tax.paid", {
		tracker: "270000000000001",
		account: "Federal941",
		kind: "Penalty",
		period: "2026Q1",
		amount: "306.01",
		initiatedOn: "2026-02-10",
		mercury: "061036010000001",
		sentOn: "2026-02-11"
	})
	assert.ok((await blockers(ledger, "2026-04-02")).includes("941 deposit"))
	await deposit(ledger, "2026Q1", "306.01", "2026-02-10")
	assert.ok(!(await blockers(ledger, "2026-04-02")).includes("941 deposit"))
})

test("Texas UI and FUTA block until paid; excess shows as a credit", async () => {
	const ledger = await ledger2026()
	await paid(ledger, "2026-01-09", check)
	await deposit(ledger, "2026Q1", "306.01", "2026-02-10")
	assert.deepEqual(await blockers(ledger, "2026-04-01"), ["Texas UI tax", "File F941", "File C3"])
	await deposit(ledger, "2026Q1", "54.01", "2026-04-10", "TexasUI")
	await op(ledger, "filing.record", {
		form: "F941",
		period: "2026Q1",
		...certified,
		tracking: "9400100000000000000001"
	})
	await op(ledger, "filing.record", {
		form: "C3",
		period: "2026Q1",
		method: "Electronic",
		on: "2026-04-10",
		confirmation: "1"
	})
	assert.deepEqual(await blockers(ledger, "2026-04-10"), [])
	const credits = (await status(ledger, "2026-04-10")).credits
	assert.deepEqual(credits, [{ account: "TexasUI", period: "2026Q1", credit: "0.01" }])
	assert.ok((await blockers(ledger, "2027-01-01")).includes("FUTA tax"))
	await deposit(ledger, "2026", "12.00", "2027-01-05", "Federal940")
	assert.ok(!(await blockers(ledger, "2027-01-05")).includes("FUTA tax"))
})

test("an underpaid paycheck blocks until topped up; Roth can't drop below what was wired", async () => {
	const ledger = await ledger2026()
	await paid(ledger, "2026-01-09", { ...check, roth: "0.00" })
	await assert.rejects(op(ledger, "payroll.correct", { paidOn: "2026-01-09", roth: "-1.00" }), {
		code: "InvalidInput"
	})
	await paid(ledger, "2026-01-16", check)
	await assert.rejects(op(ledger, "payroll.correct", { paidOn: "2026-01-16", roth: "400.00" }), {
		code: "LawRefused"
	})
	const corrected = await op(ledger, "payroll.correct", { paidOn: "2026-01-16", roth: "600.00" })
	assert.equal(corrected.net, "1246.99")
	assert.deepEqual(await blockers(ledger, "2026-01-16"), ["Send Roth to Carry"])
	await op(ledger, "payroll.correct", { paidOn: "2026-01-16", roth: "500.00" })
	await op(ledger, "payroll.correct", { paidOn: "2026-01-16", gross: "2100.00" })
	const owed = (await status(ledger, "2026-01-16")).blockers as { what: string; amount: string }[]
	assert.deepEqual(owed, [
		{
			what: "Send net pay",
			next: "transfer.record",
			paidOn: "2026-01-16",
			opensOn: "2026-01-16",
			dueOn: "2026-01-16",
			amount: "92.35"
		}
	])
	await op(ledger, "transfer.record", {
		kind: "NetPay",
		paidOn: "2026-01-16",
		mercury: sendMoney(),
		sentOn: "2026-01-17",
		amount: "92.35"
	})
	assert.deepEqual(await blockers(ledger, "2026-01-17"), [])
})

test("an overpaid paycheck is recovered by the next one", async () => {
	const ledger = await ledger2026()
	await paid(ledger, "2026-01-09", check)
	await op(ledger, "payroll.correct", { paidOn: "2026-01-09", fit: "100.01" })
	const before = await status(ledger, "2026-01-16")
	assert.deepEqual(before.blockers, [])
	assert.deepEqual(before.overpaid, [{ paidOn: "2026-01-09", excess: "100.00" }])
	const next = await op(ledger, "payroll.quote", { paidOn: "2026-01-16", input: check })
	assert.deepEqual(next.recovered, [{ paidOn: "2026-01-09", amount: "100.00" }])
	assert.equal(next.net, "1246.99")
	const net = await op(ledger, "payroll.quote", {
		paidOn: "2026-01-16",
		input: { by: "net", net: "1346.99" }
	})
	assert.equal(net.net, "1346.99")
	const posted = await paid(ledger, "2026-01-16", check)
	assert.equal(posted.net, "1246.99")
	assert.deepEqual((await status(ledger, "2026-01-16")).overpaid, [])
})

const federal941 = (items: string[]) => items.filter((what) => /941/.test(what))
const file941 = (ledger: string) =>
	op(ledger, "filing.record", {
		form: "F941",
		period: "2026Q1",
		...certified,
		tracking: "9400100000000000000001"
	})

test("a changed paycheck in a filed quarter opens a 941-X; its line 27 is owed until paid", async () => {
	const ledger = await ledger2026()
	await paid(ledger, "2026-01-09", check)
	await deposit(ledger, "2026Q1", "306.01", "2026-02-10")
	await file941(ledger)
	assert.deepEqual(federal941(await blockers(ledger, "2026-04-02")), [])
	await op(ledger, "payroll.correct", { paidOn: "2026-01-09", fit: "50.01" })
	assert.deepEqual(federal941(await blockers(ledger, "2026-04-02")), ["File a 941-X"])
	await op(ledger, "filing.correct", {
		period: "2026Q1",
		mailedOn: "2026-04-03",
		tracking: "9400100000000000000002"
	})
	const owed = (await status(ledger, "2026-04-03")).blockers as {
		what: string
		amount?: string
		dueOn?: string
	}[]
	assert.deepEqual(
		owed.filter((item) => /941/.test(item.what)).map(({ what, amount, dueOn }) => ({ what, amount, dueOn })),
		[{ what: "941-X balance", amount: "50.00", dueOn: "2026-04-03" }]
	)
	await op(ledger, "tax.paid", {
		tracker: "270000000000009",
		account: "Federal941",
		kind: "Balance",
		period: "2026Q1",
		amount: "50.00",
		initiatedOn: "2026-04-03",
		mercury: "061036010000009",
		sentOn: "2026-04-03"
	})
	assert.deepEqual(federal941(await blockers(ledger, "2026-04-03")), [])
	assert.deepEqual((await status(ledger, "2026-04-03")).credits, [])
})

test("payments clear what a quarter owes in the order it arose", async () => {
	const ledger = await ledger2026()
	await paid(ledger, "2026-03-06", check)
	await deposit(ledger, "2026Q1", "306.01", "2026-04-01")
	await file941(ledger)
	await op(ledger, "payroll.correct", { paidOn: "2026-03-06", fit: "10.01" })
	await op(ledger, "filing.correct", {
		period: "2026Q1",
		mailedOn: "2026-04-03",
		tracking: "9400100000000000000002"
	})
	const owed = (await status(ledger, "2026-04-03")).blockers as { what: string; amount?: string }[]
	assert.deepEqual(
		owed.filter((item) => /941/.test(item.what)).map(({ what, amount }) => [what, amount]),
		[["941-X balance", "10.00"]]
	)
})

test("only the 941's reported facts make it stale, not line 7's rounding", async () => {
	const ledger = await ledger2026()
	await paid(ledger, "2026-01-09", check)
	await deposit(ledger, "2026Q1", "306.01", "2026-02-10")
	await file941(ledger)
	const ss = (await read(ledger)).Withholding.find((row) => row.tax === "SocialSecurity")
	const old = ss ?? assert.fail("no social security withheld")
	await commit(ledger, [
		...remove("Withholding", old),
		...insert("Withholding", { ...old, amount: old.amount + 1n })
	])
	assert.deepEqual(federal941(await blockers(ledger, "2026-04-02")), [])
})

test("a filed 941 is what its quarter owes, whatever a recompute says", async () => {
	const ledger = await ledger2026()
	await paid(ledger, "2026-01-09", check)
	const lines = (
		(await op(ledger, "report", { year: 2026, quarter: 1 })).forms as {
			F941: { lines: { [line: string]: string | number } }
		}
	).F941.lines
	const id = filingId("F941", quarterSpan(2026, 1))
	const asFiled = { F941_10: "306.04", F941_12: "306.04", F941_16_1: "306.04" } as { [line: string]: string }
	await commit(ledger, [
		...insert("Filing", { id, form: "F941", period: quarterSpan(2026, 1), method: "CertifiedMail" }),
		...insert("CertifiedMail", { filing: id, mailedOn: parseDate("2026-04-02"), tracking: "9400" }),
		...insert(
			"FiledFigures",
			...Object.entries(lines).map(([line, value]) => ({
				filing: id,
				line: line as LineHandle,
				value: typeof value === "number" ? BigInt(value) : $(asFiled[line] ?? value)
			}))
		)
	])
	assert.deepEqual(federal941(await blockers(ledger, "2026-04-02")), ["941 deposit"])
	await deposit(ledger, "2026Q1", "306.04", "2026-04-02")
	assert.deepEqual(federal941(await blockers(ledger, "2026-04-02")), [])
	assert.deepEqual((await status(ledger, "2026-04-02")).credits, [])
})

test("a 941-X owes its column 4, even a cent away from a recompute", async () => {
	const ledger = await ledger2026()
	await paid(ledger, "2026-01-09", { by: "gross", gross: "1000.01" })
	await deposit(ledger, "2026Q1", "153.01", "2026-02-10")
	await file941(ledger)
	await op(ledger, "payroll.correct", { paidOn: "2026-01-09", gross: "1000.05" })
	await op(ledger, "transfer.record", {
		kind: "NetPay",
		paidOn: "2026-01-09",
		mercury: sendMoney(),
		sentOn: "2026-04-02",
		amount: "0.04"
	})
	await op(ledger, "filing.correct", {
		period: "2026Q1",
		mailedOn: "2026-05-01",
		tracking: "9400100000000000000002"
	})
	const report = await op(ledger, "report", { year: 2026, quarter: 1 })
	assert.equal((report.forms as { F941: { lines: { F941_12: string } } }).F941.lines.F941_12, "153.02")
	assert.equal((report.correction as { line27: string }).line27, "0.00")
	assert.deepEqual(federal941(await blockers(ledger, "2026-05-01")), [])
	assert.deepEqual((await status(ledger, "2026-05-01")).credits, [])
})

test("1099-R obligations come only with plan activity", async () => {
	const ledger = await ledger2026()
	await paid(ledger, "2026-01-09", check)
	const forms = async () =>
		(await blockers(ledger, "2027-01-02")).filter((what) => what === "File F1099R" || what === "File F1096")
	assert.deepEqual(await forms(), [])
	await op(ledger, "plan.rollover", { account: "Roth", on: "2026-02-01", gross: "400.00" })
	assert.deepEqual(await forms(), ["File F1099R", "File F1096"])
})

test("each year's policy and election block from January 1 and show from December 1", async () => {
	const ledger = await ledger2026()
	const policy = ["Set the federal policy", "Record the signed election", "Set the TX policy"]
	const upcoming = async (asOf: string) => whats((await status(ledger, asOf)).upcoming)
	assert.deepEqual(
		(await upcoming("2026-11-30")).filter((what) => policy.includes(what)),
		[]
	)
	assert.deepEqual(
		(await upcoming("2026-12-01")).filter((what) => policy.includes(what)),
		policy
	)
	assert.deepEqual((await status(ledger, "2026-12-01")).setup, ["plan.set 2027"])
	assert.deepEqual(
		(await blockers(ledger, "2027-01-01")).filter((what) => policy.includes(what)),
		policy
	)
	await op(ledger, "policy.set", federal(2027))
	await op(ledger, "election.set", { year: 2027, roth: "24500.00", afterTax: "0.00", signedOn: "2026-12-15" })
	assert.deepEqual(
		(await blockers(ledger, "2027-01-01")).filter((what) => policy.includes(what)),
		["Set the TX policy"]
	)
	await op(ledger, "policy.set", texas(2027))
	assert.deepEqual(
		(await blockers(ledger, "2027-01-01")).filter((what) => policy.includes(what)),
		[]
	)
})

test("returns begin with employment, not before it", async () => {
	const ledger = await ledger2026("2026-04-01")
	const items = (await status(ledger, "2026-07-01")).blockers as { what: string; period: string }[]
	assert.deepEqual(
		items.map((item) => `${item.what} ${item.period}`),
		["File F941 2026Q2", "File C3 2026Q2"]
	)
})
