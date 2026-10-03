import assert from "node:assert/strict"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { test } from "node:test"
import { Exit } from "effect"
import { cli, describeCause } from "../src/cli.ts"
import {
	achTrace,
	deposit,
	federal,
	freshLedger,
	ledger2026,
	op,
	paid,
	read,
	runtime,
	scratchPath,
	sendMoney,
	setup,
	texas
} from "./support.ts"

/* Every write echoes its input in boundary units, and running it again is no
 * change. */

const twice = async (ledger: string, name: string, payload: object) => {
	const first = await op(ledger, name, payload)
	const { outcome, ...echo } = first
	assert.equal(outcome, "committed", name)
	assert.deepEqual(await op(ledger, name, payload), { ...echo, outcome: "no-change" }, name)
	return echo
}

test("each write round-trips and an identical re-run is no change", async () => {
	const ledger = freshLedger()
	assert.deepEqual(await op(ledger, "setup", setup()), { outcome: "committed", ...setup() })
	await assert.rejects(op(ledger, "setup", setup()), { code: "LedgerExists" })
	assert.deepEqual(await twice(ledger, "policy.set", federal(2026)), federal(2026))
	assert.deepEqual(await twice(ledger, "policy.set", texas(2026)), texas(2026))
	const plan = { year: 2026, salary: "120000.00", fitPerCheck: "0.01" }
	assert.deepEqual(await twice(ledger, "plan.set", plan), plan)
	const election = { year: 2026, roth: "24500.00", afterTax: "47500.00", signedOn: "2026-01-02" }
	assert.deepEqual(await twice(ledger, "election.set", election), election)

	const request = { paidOn: "2026-01-09", input: { by: "plan", roth: "100.00" } }
	const quote = await op(ledger, "payroll.quote", request)
	assert.equal(quote.laws, "admitted")
	const check = await twice(ledger, "payroll.post", request)
	const { blockers, laws, ...priced } = quote
	assert.deepEqual(check, priced)
	assert.deepEqual(blockers, [])
	await assert.rejects(
		op(ledger, "payroll.post", { paidOn: "2026-01-09", input: { by: "gross", gross: "100.00" } }),
		{ code: "WageExists" }
	)
	const fixed = await twice(ledger, "payroll.correct", { paidOn: "2026-01-09", fit: "1.00" })
	assert.deepEqual([fixed.fit, fixed.ss, fixed.medicare], ["1.00", check.ss, check.medicare])
	await op(ledger, "payroll.correct", { paidOn: "2026-01-09", fit: "0.01" })

	const wires = [
		{ kind: "NetPay", paidOn: "2026-01-09", mercury: sendMoney(), sentOn: "2026-01-09", amount: check.net },
		{
			kind: "RothDeferral",
			paidOn: "2026-01-09",
			mercury: sendMoney(),
			sentOn: "2026-01-09",
			amount: "100.00"
		},
		{ kind: "AfterTax", year: 2026, mercury: sendMoney(), sentOn: "2026-01-10", amount: "1000.00" },
		{ kind: "Distribution", mercury: sendMoney(), sentOn: "2026-01-10", amount: "5000.00" }
	]
	for (const wire of wires) assert.deepEqual(await twice(ledger, "transfer.record", wire), wire)
	const payment = {
		tracker: "270000000000001",
		account: "Federal941",
		kind: "Deposit",
		period: "2026Q1",
		amount: "100.00",
		initiatedOn: "2026-02-10",
		mercury: achTrace(),
		sentOn: "2026-02-11"
	}
	assert.deepEqual(await twice(ledger, "tax.paid", payment), payment)
	const sweep = { account: "Roth", on: "2026-02-02", gross: "1150.00" }
	assert.deepEqual(await twice(ledger, "plan.rollover", sweep), {
		...sweep,
		taxable: "0.00",
		basis: "1100.00",
		converted: "1000.00"
	})

	const c3 = {
		form: "C3",
		period: "2026Q1",
		method: "Electronic",
		on: "2026-04-02",
		confirmation: "12345678"
	}
	assert.deepEqual(await twice(ledger, "filing.record", c3), c3)
	const f941 = {
		form: "F941",
		period: "2026Q1",
		method: "CertifiedMail",
		mailedOn: "2026-04-02",
		tracking: "9400100000000000000003"
	}
	await twice(ledger, "filing.record", f941)
	const correction = {
		form: "F941",
		period: "2026Q1",
		mailedOn: "2026-05-01",
		tracking: "9400100000000000000004"
	}
	await assert.rejects(op(ledger, "filing.correct", correction), { code: "NothingToCorrect" })
	await op(ledger, "payroll.correct", { paidOn: "2026-01-09", fit: "1.00" })
	assert.deepEqual(await twice(ledger, "filing.correct", correction), correction)
	await assert.rejects(op(ledger, "filing.correct", { ...correction, tracking: "9400100000000000000005" }), {
		code: "Corrected"
	})
	await assert.rejects(op(ledger, "filing.correct", { ...correction, form: "C3" }), { code: "InvalidInput" })

	const facts = await read(ledger)
	const filed = (form: string) => facts.Filing.find((row) => row.form === form)?.id
	const figures = facts.FiledFigures.filter((row) => row.filing === filed("F941"))
	assert.equal(figures.length, 18)
	assert.equal(figures.find((row) => row.line === "F941_16_3")?.value, 0n)
	assert.equal(facts.FiledFigures.filter((row) => row.filing === filed("C3")).length, 7)
	assert.deepEqual(
		facts.CorrectedFigures.map(({ line, value }) => [line, value]),
		[["F941_3", 100n]]
	)
	assert.equal((await op(ledger, "status", { asOf: "2026-01-09" })).asOf, "2026-01-09")
	assert.equal((await op(ledger, "report", { year: 2026, quarter: 1 })).period, "2026Q1")
})

test("policy.set replaces one jurisdiction's year whole", async () => {
	const ledger = await ledger2026()
	const raised = {
		...federal(2026),
		rates: { ...federal(2026).rates, SocialSecurity: { rate: "6.2", base: "190000.00" } }
	}
	assert.equal((await op(ledger, "policy.set", raised)).outcome, "committed")
	const bands = (await read(ledger)).TaxBand
	assert.equal(bands.length, 4)
	assert.equal(bands.find((band) => band.tax === "SocialSecurity")?.wages.end, 19_000_000n)
	assert.equal((await op(ledger, "policy.set", raised)).outcome, "no-change")
	assert.equal((await op(ledger, "policy.set", texas(2026))).outcome, "no-change")
	await assert.rejects(op(ledger, "policy.set", { ...texas(2027) }), { code: "LawRefused" })
	await assert.rejects(
		op(ledger, "policy.set", {
			...federal(2026),
			limits: { ...federal(2026).limits, additionsLimit: "60000.00" }
		}),
		{ code: "Over415c" }
	)
})

test("an export imports into an identical ledger", async () => {
	const ledger = await ledger2026()
	await paid(ledger, "2026-01-09", { by: "gross", gross: "2000.00", roth: "500.00" })
	await deposit(ledger, "2026Q1", "306.01", "2026-02-10")
	const exported = await op(ledger, "export", {})
	assert.equal(exported.out, ledger.replace(/ledger-\d+$/, "Wagie Tools - CURRENT.facts.json"))
	const copy = freshLedger()
	const imported = await op(copy, "import", { file: exported.out as string })
	assert.equal(imported.facts, exported.facts)
	const again = await op(copy, "export", { out: scratchPath("again.json") })
	assert.equal(readFileSync(again.out as string, "utf8"), readFileSync(exported.out as string, "utf8"))
	await assert.rejects(op(copy, "import", { file: exported.out as string }), { code: "LedgerExists" })
})

test("a refused import leaves no ledger behind", async () => {
	const ledger = await ledger2026()
	await paid(ledger, "2026-01-09", { by: "gross", gross: "2000.00" })
	const { out } = await op(ledger, "export", { out: scratchPath("valid.json") })
	const facts = JSON.parse(readFileSync(out as string, "utf8"))
	facts.Election = []
	const broken = scratchPath("broken.json")
	writeFileSync(broken, JSON.stringify(facts))
	const copy = freshLedger()
	await assert.rejects(op(copy, "import", { file: broken }), { code: "LawRefused" })
	assert.equal(existsSync(copy), false)
})

test("an import attests only filings inside its history", async () => {
	const ledger = await ledger2026()
	await op(ledger, "filing.record", {
		form: "C3",
		period: "2026Q1",
		method: "Electronic",
		on: "2026-04-02",
		confirmation: "1"
	})
	const { out } = await op(ledger, "export", { out: scratchPath("filed.json") })
	const facts = JSON.parse(readFileSync(out as string, "utf8"))
	facts.Filing = facts.Filing.map((row: { method: string }) => ({ ...row, method: "Attested" }))
	facts.Electronic = []
	const attested = scratchPath("attested.json")
	writeFileSync(attested, JSON.stringify(facts))
	await assert.rejects(op(freshLedger(), "import", { file: attested }), { code: "LawRefused" })
	facts.History = [{ span: { start: facts.Filing[0].period.start, end: facts.Filing[0].period.end } }]
	writeFileSync(attested, JSON.stringify(facts))
	assert.equal((await op(freshLedger(), "import", { file: attested })).outcome, "committed")
})

test("the boundary refuses what the ledger can't hold", async () => {
	const ledger = await ledger2026()
	await paid(ledger, "2026-01-09", { by: "gross", gross: "2000.00" })
	await paid(ledger, "2026-01-16", { by: "gross", gross: "2000.00" })
	const refuses = (name: string, payload: object, code: string) =>
		assert.rejects(op(ledger, name, payload), { code })
	await refuses(
		"transfer.record",
		{
			kind: "NetPay",
			paidOn: "2026-01-09",
			mercury: "17a4c3a2-b1ed-11f1-88cd-472025dfa48e",
			sentOn: "2026-01-09",
			amount: "1.00"
		},
		"InvalidInput"
	)
	await refuses(
		"tax.paid",
		{
			tracker: "270000000000001",
			account: "Federal941",
			kind: "Deposit",
			period: "2026Q1",
			amount: "1.00",
			initiatedOn: "2026-02-10",
			sentOn: "2026-02-11"
		},
		"InvalidInput"
	)
	await refuses("filing.record", { form: "F941", period: "2026Q1", method: "Attested" }, "InvalidInput")
	await refuses(
		"filing.record",
		{ form: "F941", period: "2026", method: "CertifiedMail", mailedOn: "2027-01-02", tracking: "1" },
		"InvalidPeriod"
	)
	await refuses("tax.paid", { ...depositInput, account: "Federal940", period: "2026Q1" }, "InvalidPeriod")
	await refuses(
		"policy.set",
		{ ...texas(2026), rates: { TexasUnemployment: { rate: "2.70001" } } },
		"InvalidInput"
	)
	await refuses("policy.set", { ...texas(2026), rates: { Medicare: { rate: "1.45" } } }, "InvalidInput")
	await refuses("plan.rollover", { account: "Roth", on: "2026-02-02", gross: "0.00" }, "InvalidInput")
	await refuses("payroll.correct", { paidOn: "2026-01-09", gross: "2100.00" }, "GrossNotLatest")
	await refuses("payroll.post", { paidOn: "2026-01-08", input: { by: "gross", gross: "1.00" } }, "Backdated")
	await refuses(
		"payroll.post",
		{ paidOn: "2026-01-23", input: { by: "gross", gross: "1.00" }, extra: true },
		"InvalidInput"
	)
	await refuses("status", { asOf: "2026-02-30" }, "InvalidInput")
	await refuses("nonsense", {}, "UnknownOp")
})
const depositInput = {
	tracker: "270000000000002",
	account: "Federal941",
	kind: "Deposit",
	period: "2026Q1",
	amount: "1.00",
	initiatedOn: "2026-02-10",
	mercury: "061036010000002",
	sentOn: "2026-02-11"
}

test("with no op, the command line lists the ops", async () => {
	const listed = (await runtime.runPromise(cli([]))) as { op: string; summary: string }[]
	assert.deepEqual(
		listed.map((entry) => entry.op),
		[
			"setup",
			"policy.set",
			"plan.set",
			"election.set",
			"payroll.quote",
			"payroll.post",
			"payroll.correct",
			"transfer.record",
			"tax.paid",
			"plan.rollover",
			"filing.record",
			"filing.correct",
			"status",
			"report",
			"export",
			"import"
		]
	)
	const exit = await runtime.runPromiseExit(cli(["status", "[]"]))
	assert.ok(Exit.isFailure(exit))
	assert.deepEqual(describeCause(exit.cause), [{ code: "InvalidJson", message: "Give one JSON object" }])
})
