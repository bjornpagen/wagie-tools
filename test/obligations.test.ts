import assert from "node:assert/strict"
import { test } from "node:test"
import { deposit, ledger2026, op, paid, sendMoney, whats } from "./support.ts"

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

test("a changed paycheck in a filed quarter opens a 941-X", async () => {
	const ledger = await ledger2026()
	await paid(ledger, "2026-01-09", check)
	await deposit(ledger, "2026Q1", "306.01", "2026-02-10")
	await op(ledger, "filing.record", {
		form: "F941",
		period: "2026Q1",
		...certified,
		tracking: "9400100000000000000001"
	})
	assert.ok(!(await blockers(ledger, "2026-04-02")).includes("File a 941-X"))
	await op(ledger, "payroll.correct", { paidOn: "2026-01-09", fit: "50.01" })
	assert.ok((await blockers(ledger, "2026-04-02")).includes("File a 941-X"))
	await op(ledger, "filing.amend", {
		period: "2026Q1",
		mailedOn: "2026-04-03",
		tracking: "9400100000000000000002"
	})
	assert.ok(!(await blockers(ledger, "2026-04-03")).includes("File a 941-X"))
})

test("1099-R obligations come only with plan activity", async () => {
	const ledger = await ledger2026()
	await paid(ledger, "2026-01-09", check)
	const forms = async () =>
		(await blockers(ledger, "2027-01-02")).filter((what) => what === "File F1099R" || what === "File F1096")
	assert.deepEqual(await forms(), [])
	await op(ledger, "transfer.record", {
		kind: "AfterTax",
		year: 2026,
		mercury: sendMoney(),
		sentOn: "2026-02-01",
		amount: "1000.00"
	})
	assert.deepEqual(await forms(), ["File F1099R", "File F1096"])
})
