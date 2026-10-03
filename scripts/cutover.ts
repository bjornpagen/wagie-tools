/**
 * One-off cutover from the BumbleDB-Log ledger of commit 6212f9f to this
 * schema. It is deleted in the commit after it has run.
 *
 * 1. Inputs, made at 6212f9f before checking this commit out:
 *
 *      git checkout 6212f9f
 *      mkdir -p private/cutover/golden
 *      node scripts/facts.ts --out private/cutover/facts.json
 *      B=$(node -p 'JSON.parse(require("fs").readFileSync("private/cutover/facts.json")).facts.Business[0].id')
 *      for p in 2025:2 2025:3 2025:4 2026:1 2026:2 2026:3 2026:4; do
 *        echo "{\"read\":\"report\",\"business\":\"$B\",\"year\":${p%:*},\"quarter\":${p#*:}}" \
 *          | node src/cli.ts read > "private/cutover/golden/${p%:*}Q${p#*:}.json"
 *      done
 *      for y in 2025 2026; do
 *        echo "{\"read\":\"report\",\"business\":\"$B\",\"year\":$y}" | node src/cli.ts read > "private/cutover/golden/$y.json"
 *      done
 *      echo "{\"read\":\"status\",\"business\":\"$B\"}" | node src/cli.ts read > private/cutover/golden/status.json
 *
 *    plus, in private/cutover/, a fresh Mercury export through at least
 *    2026-10-03 as mercury.csv and the EFTPS payment history as eftps.csv.
 *
 * 2. At this commit (Node 24):
 *
 *      node scripts/cutover.ts --dry-run   # import and check; touches nothing
 *      node scripts/cutover.ts             # then move the old ledger aside,
 *                                          # import the new one, export it
 *
 * Every check runs before anything moves. `--inputs DIR` and `--private DIR`
 * point elsewhere; `--without-anchors` skips the checks of the real figures
 * and exists only to rehearse on synthetic inputs.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { type Fact, NativeRuntime, type Uuid } from "@bjornpagen/bumbledb"
import { Effect, Exit, Schema } from "effect"
import { isBusinessDay } from "../src/calendar.ts"
import { grossOf, nearest, paychecks, type Rules, under } from "../src/check.ts"
import { describeCause } from "../src/cli.ts"
import { formatDollars, parseDollars } from "../src/core/boundary.ts"
import {
	civil,
	dayOf,
	formatDate,
	formatPeriod,
	parseDate,
	parsePeriod,
	point,
	quarterOf,
	quarterSpan,
	type Span,
	sameSpan,
	yearOf,
	yearSpan
} from "../src/core/time.ts"
import { MAX_I64, MAX_U64, Refusal, sum } from "../src/core/values.ts"
import * as Db from "../src/db.ts"
import { correctable, figures, periodOf } from "../src/forms.ts"
import { obligations, status } from "../src/obligations.ts"
import { filingId, run, wageId } from "../src/ops.ts"
import type { report } from "../src/reports.ts"
import { MercuryTrackingId } from "../src/schema/input.ts"
import type * as S from "../src/schema.ts"
import { LegacyFiling } from "../src/schema.ts"

// ── arguments and inputs ───────────────────────────────────────────────────

const args = process.argv.slice(2)
const flag = (name: string) => {
	const index = args.indexOf(`--${name}`)
	return index === -1 ? undefined : args[index + 1]
}
const dryRun = args.includes("--dry-run")
const withAnchors = !args.includes("--without-anchors")
const privateDir = path.resolve(flag("private") ?? path.join(Db.repositoryRoot, "private"))
const inputs = path.resolve(flag("inputs") ?? path.join(privateDir, "cutover"))
const ledger = path.join(privateDir, "ledger")
const aside = path.join(inputs, "old-ledger")

const fail = (message: string): never => {
	throw new Refusal({ code: "Cutover", message })
}
process.on("uncaughtException", (error) => {
	process.stderr.write(`${error instanceof Refusal ? `cutover refused: ${error.message}` : error.stack}\n`)
	process.exit(1)
})
const check = (ok: boolean, message: string) => {
	if (!ok) fail(message)
}
const log = (message: string) => process.stdout.write(`${message}\n`)
if (!dryRun && existsSync(aside)) fail(`${aside} exists; the cutover already ran`)
const $ = (cents: bigint) => formatDollars(cents)

type Row = Readonly<Record<string, unknown>>
const old = JSON.parse(readFileSync(path.join(inputs, "facts.json"), "utf8")) as {
	facts: Record<string, Row[]>
}
const rows = (name: string): readonly Row[] => old.facts[name] ?? []
const text = (row: Row, field: string) => {
	const value = row[field]
	return typeof value === "string" ? value : fail(`${JSON.stringify(row)} has no text ${field}`)
}
const int = (row: Row, field: string) => BigInt(text(row, field))
const interval = (row: Row, field: string): Span => {
	const value = row[field] as { start?: unknown; end?: unknown } | undefined
	return typeof value?.start === "string" && typeof value.end === "string"
		? { start: BigInt(value.start), end: BigInt(value.end) }
		: fail(`${JSON.stringify(row)} has no interval ${field}`)
}
const index = (name: string, field: string) => {
	const byField = new Map<string, Row[]>()
	for (const row of rows(name)) byField.set(text(row, field), [...(byField.get(text(row, field)) ?? []), row])
	return (value: string) => byField.get(value) ?? []
}
const one = <A>(found: readonly A[], what: string): A =>
	found.length === 1 ? (found[0] as A) : fail(`Expected one ${what}, found ${found.length}`)
const only = <A>(values: readonly A[], what: string): A => {
	const distinct = [...new Set(values)]
	return distinct.length === 1
		? (distinct[0] as A)
		: fail(`Expected one ${what}, found ${distinct.join(", ") || "none"}`)
}

// ── CSV ────────────────────────────────────────────────────────────────────

/** RFC 4180: quoted fields, doubled quotes, CRLF or LF. */
const parseCsv = (source: string) => {
	const records: string[][] = []
	let record: string[] = []
	let field = ""
	let quoted = false
	const body = source.replace(/^﻿/, "")
	for (let i = 0; i < body.length; i++) {
		const c = body[i]
		if (quoted) {
			if (c === '"' && body[i + 1] === '"') {
				field += '"'
				i++
			} else if (c === '"') quoted = false
			else field += c
		} else if (c === '"') quoted = true
		else if (c === ",") {
			record.push(field)
			field = ""
		} else if (c === "\n" || c === "\r") {
			if (c === "\r" && body[i + 1] === "\n") i++
			record.push(field)
			if (record.some((cell) => cell !== "")) records.push(record)
			record = []
			field = ""
		} else field += c
	}
	record.push(field)
	if (record.some((cell) => cell !== "")) records.push(record)
	const [header = [], ...data] = records
	const names = header.map((name) => name.trim())
	const column = (file: string, ...candidates: string[]) => {
		const found = names.findIndex((name) =>
			candidates.some((candidate) => name.toLowerCase() === candidate.toLowerCase())
		)
		return found === -1
			? fail(`${file} has no ${candidates.join(" / ")} column; it has ${names.join(", ")}`)
			: found
	}
	return { data, column, names }
}
/** EFTPS prefixes numbers with an apostrophe so spreadsheets keep them text. */
const cell = (record: readonly string[], at: number) => (record[at] ?? "").trim().replace(/^'/, "")
const csvMoney = (value: string) => {
	const negative = /^\(.*\)$/.test(value) || value.startsWith("-")
	const digits = value.replace(/[()$,\s-]/g, "")
	const cents = parseDollars(/\.\d{2}$/.test(digits) ? digits : `${digits}.00`)
	return negative ? -cents : cents
}
const csvDate = (value: string) => {
	const us = /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})/.exec(value)
	if (us) return dayOf(Number(us[3]), Number(us[1]), Number(us[2]))
	const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(value)
	return iso ? parseDate(iso[0]) : fail(`Not a date: ${value}`)
}

type Bank = {
	readonly date: bigint
	readonly amount: bigint
	readonly status: string
	/** Description and Bank Description: who was paid. */
	readonly payee: string
	/** Every cell, for memos such as the Carry account. */
	readonly text: string
	readonly tracking: string
}
const mercury: readonly Bank[] = (() => {
	const file = "mercury.csv"
	const csv = parseCsv(readFileSync(path.join(inputs, file), "utf8"))
	const at = {
		date: csv.column(file, "Date (UTC)", "Date"),
		description: csv.column(file, "Description"),
		bank: csv.names.indexOf("Bank Description"),
		amount: csv.column(file, "Amount"),
		status: csv.column(file, "Status"),
		tracking: csv.column(file, "Tracking ID")
	}
	return csv.data.map((record) => ({
		date: csvDate(cell(record, at.date)),
		amount: csvMoney(cell(record, at.amount)),
		status: cell(record, at.status),
		payee: `${cell(record, at.description)} ${at.bank === -1 ? "" : cell(record, at.bank)}`,
		text: record.join(" "),
		tracking: cell(record, at.tracking)
	}))
})()
const sent = mercury.filter((row) => row.status.toLowerCase() === "sent")
const irs = /\bIRS\b|USATAXPYMT|internal revenue|eftps/i
/** The money-out rows the ledger tracks: payroll and distributions to the
 * owner, Carry, the IRS and TWC. */
const tracked = (row: Bank) =>
	row.amount < 0n && (irs.test(row.payee) || /pagen|carry|drivewealth|workforce|\bTWC\b/i.test(row.payee))
{
	const untracked = sent.filter((row) => tracked(row) && row.tracking === "")
	check(
		untracked.length === 0,
		`Sent mercury.csv rows without a Tracking ID: ${untracked.map((row) => `${formatDate(row.date)} ${row.payee}`).join("; ")}`
	)
}

type Eftps = { readonly eft: string; readonly trace: string; readonly record: readonly string[] }
const eftps = (() => {
	const file = "eftps.csv"
	const csv = parseCsv(readFileSync(path.join(inputs, file), "utf8"))
	const eft = csv.column(file, "EFT Number")
	const trace = csv.column(file, "ACH Trace Number")
	const rows: Eftps[] = csv.data.map((record) => ({
		eft: cell(record, eft),
		trace: cell(record, trace),
		record
	}))
	const named = (pattern: RegExp) => {
		const found = csv.names.findIndex((name) => pattern.test(name))
		return found === -1
			? fail(`eftps.csv has no column like ${pattern}; it has ${csv.names.join(", ")}`)
			: found
	}
	return { rows, named }
})()
/** An EFTPS tax period ("202512", "2025-12", "12/2025" or a date): the
 * quarter it names, or the year for a 940. */
const eftpsPeriod = (value: string, form: string): Span => {
	const yearFirst = /^(\d{4})[-/]?(\d{1,2})$/.exec(value)
	const monthFirst = /^(\d{1,2})[-/](\d{4})$/.exec(value)
	const { year, month } = yearFirst
		? { year: Number(yearFirst[1]), month: Number(yearFirst[2]) }
		: monthFirst
			? { year: Number(monthFirst[2]), month: Number(monthFirst[1]) }
			: civil(csvDate(value))
	return /940/.test(form) ? yearSpan(year) : quarterOf(dayOf(year, month, 1))
}

// ── the new facts ──────────────────────────────────────────────────────────

type Mutable = { -readonly [N in Db.Name]: Fact<Db.Stored[N]>[] }
const facts: Mutable = {
	Business: [],
	Employee: [],
	Employment: [],
	TaxYear: [],
	PayPlan: [],
	Election: [],
	Wage: [],
	Recovery: [],
	Transfer: [],
	NetPay: [],
	RothDeferral: [],
	AfterTax: [],
	Distribution: [],
	TaxDebit: [],
	TaxPayment: [],
	OutsideMercury: [],
	Filing: [],
	Electronic: [],
	CertifiedMail: [],
	Furnished: [],
	Prior: [],
	FiledFigures: [],
	Correction: [],
	CorrectedFigures: [],
	PlanDistribution: []
}
const cents = (dollars: string) => parseDollars(dollars)

// Business, employee, employment.
const business = one(rows("Business"), "Business")
facts.Business.push({
	ein: text(business, "ein"),
	name: text(business, "name"),
	twcAccount: text(
		one(
			rows("StateAccount").filter((row) => row.state === "TX"),
			"Texas account"
		),
		"taxpayerNumber"
	)
})
const employee = one(rows("Employee"), "Employee")
facts.Employee.push({
	ssn: text(employee, "ssn"),
	firstName: text(employee, "firstName"),
	lastName: text(employee, "lastName"),
	address: text(employee, "address")
})
const employedFrom = parseDate("2025-05-22")
facts.Employment.push({ span: { start: employedFrom, end: MAX_I64 } })

// Tax years: 2026 as the old policy rows hold it, 2025 as published.
const rules = (year: number, ssBase: string, deferral: string, additions: string, compensation: string) => ({
	year: BigInt(year),
	span: yearSpan(year),
	ssRate: 620n,
	ssBase: cents(ssBase),
	medicareRate: 145n,
	futaRate: 60n,
	futaBase: cents("7000.00"),
	sutaRate: 270n,
	sutaBase: cents("9000.00"),
	deferralLimit: cents(deferral),
	additionsLimit: cents(additions),
	compensationLimit: cents(compensation),
	wageCeiling: cents("200000.00")
})
facts.TaxYear.push(
	rules(2025, "176100.00", "23500.00", "70000.00", "350000.00"),
	rules(2026, "184500.00", "24500.00", "72000.00", "360000.00")
)
facts.PayPlan.push({ year: 2026n, salary: cents("120000.00"), fitPerCheck: 1n })
const rulesOf = (year: bigint) =>
	facts.TaxYear.find((row) => row.year === year) ?? fail(`No tax year ${year}`)

// Elections: the latest revision of each year's signed document.
{
	const superseded = new Set(rows("ElectionDocumentRevision").map((row) => text(row, "predecessor")))
	const amounts = index("ElectionDocumentAmount", "document")
	for (const document of rows("ElectionDocument").filter((row) => !superseded.has(text(row, "id")))) {
		const amount = (kind: string) =>
			sum(
				amounts(text(document, "id"))
					.filter((row) => row.kind === kind)
					.map((row) => int(row, "amount"))
			)
		check(
			amount("Traditional") === 0n && amount("EmployerProfitSharing") === 0n,
			`The ${text(document, "year")} election has pre-tax or profit-sharing amounts this ledger can't hold`
		)
		check(
			!facts.Election.some((row) => row.year === int(document, "year")),
			`${text(document, "year")} has two unrevised election documents`
		)
		facts.Election.push({
			year: int(document, "year"),
			roth: amount("Roth"),
			afterTax: amount("OptionalAfterTax"),
			signedOn: int(document, "signedOn")
		})
	}
}

// Wages: each old wage's current assessment plus its Roth deduction; the
// same-day pairs merge; earnings run cumulatively through each year.
const component = (() => {
	const successors = new Set(rows("CorrectionAssessment").map((row) => text(row, "predecessor")))
	const revisions = index("AssessmentRevision", "wage")
	const current = (wage: string) => revisions(wage).filter((row) => !successors.has(text(row, "id")))
	const observed = index("ObservedAssessment", "set")
	const calculated = index("CalculatedAssessment", "set")
	const basis = new Map(rows("CalculationBasis").map((row) => [text(row, "id"), row] as const))
	const bands = index("TaxBand", "schedule")
	const schedule = new Map(rows("RateSchedule").map((row) => [text(row, "id"), row] as const))
	/** The old engine's marginal-band arithmetic, rounded once per component. */
	const calculate = (basisId: string) => {
		const row = basis.get(basisId) ?? fail(`No CalculationBasis ${basisId}`)
		const earning = interval(row, "earning")
		const weighted = sum(
			bands(text(row, "schedule")).map((band) => {
				const wages = interval(band, "wages")
				const slice =
					(earning.end < wages.end ? earning.end : wages.end) -
					(earning.start > wages.start ? earning.start : wages.start)
				return slice > 0n ? slice * int(band, "numerator") : 0n
			})
		)
		const denominator = int(schedule.get(text(row, "schedule")) ?? fail("No RateSchedule"), "denominator")
		return {
			amount: nearest(weighted, denominator),
			earning,
			bands: bands(text(row, "schedule")),
			denominator
		}
	}
	/** A component's current amount, or undefined when the old ledger never
	 * assessed it (imported history can lack FUTA and SUTA). */
	return (wage: Row, name: string) => {
		const id = text(wage, "id")
		const revision = one(current(id), `current assessment of wage ${id}`)
		check(int(revision, "gross") === int(wage, "gross"), `Wage ${id} was regrossed by a correction`)
		const set = text(revision, "set")
		const seen = observed(set).filter((row) => row.component === name)
		if (seen.length > 0) return { amount: int(one(seen, `${name} observation of wage ${id}`), "amount") }
		const basis = calculated(set).filter((row) => row.component === name)
		return basis.length === 0
			? undefined
			: calculate(text(one(basis, `${name} assessment of wage ${id}`), "basis"))
	}
})()

type OldWage = {
	readonly id: string
	readonly day: bigint
	readonly gross: bigint
	readonly fit: bigint
	readonly ss: bigint
	readonly medicare: bigint
	readonly futa: bigint | undefined
	readonly suta: bigint | undefined
	readonly roth: bigint
}
const deductions = index("Deduction", "wage")
const oldWages: OldWage[] = rows("Wage").map((wage) => {
	const id = text(wage, "id")
	const paidOn = interval(wage, "paidOn")
	check(paidOn.end === paidOn.start + 1n, `Wage ${id} is not paid on one day`)
	check(BigInt(yearOf(paidOn.start)) === int(wage, "year"), `Wage ${id} is booked to another year`)
	check(paidOn.start >= employedFrom, `Wage ${id} predates the employment`)
	const amount = (name: string) => component(wage, name)?.amount ?? fail(`Wage ${id} has no ${name}`)
	const ss = amount("EmployeeSS")
	const medicare = amount("EmployeeMedicare")
	check(ss === amount("EmployerSS"), `Wage ${id}: employee and employer social security differ`)
	check(medicare === amount("EmployerMedicare"), `Wage ${id}: employee and employer Medicare differ`)
	// The rates the old schedules applied must be this ledger's tax year.
	const year = rulesOf(int(wage, "year"))
	for (const [name, rate, base] of [
		["EmployeeSS", year.ssRate, year.ssBase],
		["EmployeeMedicare", year.medicareRate, MAX_U64],
		["FUTA", year.futaRate, year.futaBase],
		["SUTA", year.sutaRate, year.sutaBase]
	] as const) {
		const used = component(wage, name)
		if (used === undefined || !("bands" in used)) continue
		for (const band of used.bands) {
			const wages = interval(band, "wages")
			const numerator = int(band, "numerator") * 10_000n
			const expected = wages.end <= base ? rate * used.denominator : wages.start >= base ? 0n : -1n
			check(
				numerator === expected,
				`Wage ${id}: the old ${name} band ${$(wages.start)}–${$(wages.end)} is not ${year.year}'s`
			)
		}
	}
	return {
		id,
		day: paidOn.start,
		gross: int(wage, "gross"),
		fit: amount("FIT"),
		ss,
		medicare,
		futa: component(wage, "FUTA")?.amount,
		suta: component(wage, "SUTA")?.amount,
		roth: sum(
			deductions(id)
				.filter((row) => row.kind === "Roth")
				.map((row) => int(row, "amount"))
		)
	}
})
const newWage = new Map(oldWages.map((wage) => [wage.id, wageId(wage.day)] as const))
const days = [...new Set(oldWages.map((wage) => wage.day))].sort((a, b) => (a < b ? -1 : 1))
{
	const ytd = new Map<number, bigint>()
	for (const day of days) {
		const same = oldWages.filter((wage) => wage.day === day)
		const year = yearOf(day)
		const start = ytd.get(year) ?? 0n
		const gross = sum(same.map((wage) => wage.gross))
		ytd.set(year, start + gross)
		facts.Wage.push({
			id: wageId(day),
			paidOn: point(day),
			year: BigInt(year),
			earnings: { start, end: start + gross },
			fit: sum(same.map((wage) => wage.fit)),
			ss: sum(same.map((wage) => wage.ss)),
			medicare: sum(same.map((wage) => wage.medicare)),
			roth: sum(same.map((wage) => wage.roth))
		})
	}
}
const wageOf = (oldId: string) => newWage.get(oldId) ?? fail(`No wage ${oldId}`)

// Recoveries, summed per merged pair; one inside a merged paycheck cancels.
{
	const totals = new Map<string, { wage: Uuid; recoveredBy: Uuid; amount: bigint }>()
	for (const row of rows("Recovery")) {
		const wage = wageOf(text(row, "owedOnWage"))
		const recoveredBy = wageOf(text(row, "fromWage"))
		if (wage === recoveredBy) continue
		const key = `${wage}/${recoveredBy}`
		const total = totals.get(key) ?? { wage, recoveredBy, amount: 0n }
		totals.set(key, { ...total, amount: total.amount + int(row, "amount") })
	}
	facts.Recovery.push(...totals.values())
}

// Transfers: one per Mercury movement, its arm from its cash allocations.
const isUuid = (value: string) =>
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
/** The same parser `transfer.record` and `tax.paid` use. */
const isTrackingId = Schema.is(MercuryTrackingId)
const remapped: { uuid: string; tracking: string }[] = []
/** A wire-receipt UUID becomes the Tracking ID of the one Sent row with its
 * date, amount and payee. */
const remap = (uuid: string, day: bigint, amount: bigint, carry: boolean) => {
	const payee = (row: Bank) =>
		carry
			? /carry|drivewealth/i.test(row.payee) && /QCRH000004/.test(row.text)
			: /Bjorn William Pagen/i.test(row.payee)
	const matches = sent.filter((row) => row.date === day && row.amount === -amount && payee(row))
	const tracking = one(matches, `mercury.csv row for ${uuid} (${formatDate(day)}, ${$(amount)})`).tracking
	check(isTrackingId(tracking), `${uuid} maps to ${tracking}, not a Tracking ID`)
	remapped.push({ uuid, tracking })
	return tracking
}
const tracker = (payment: string) =>
	text(
		one(
			rows("PaymentReference").filter((row) => row.payment === payment),
			`reference of payment ${payment}`
		),
		"value"
	)
{
	const allocations = index("CashAllocation", "movement")
	const references = index("MercuryTransaction", "movement")
	const failed = new Set(
		rows("BankSource")
			.filter((source) =>
				rows("BankObservation").some((row) => row.id === source.observation && row.status === "Failed")
			)
			.map((row) => text(row, "movement"))
	)
	const payroll = index("PayrollCashBinding", "allocation")
	const funding = index("ContributionFunding", "allocation")
	const contributions = new Map(rows("RetirementContribution").map((row) => [text(row, "id"), row] as const))
	const funded = index("ContributionDeduction", "contribution")
	const taxes = index("BankTaxPayment", "allocation")
	for (const movement of rows("BankMovement")) {
		const id = text(movement, "id")
		const uses = allocations(id)
		if (uses.length === 0) continue
		check(!failed.has(id), `Failed movement ${id} still funds something`)
		const purpose = only(
			uses.map((row) => text(row, "purpose")),
			`purpose for movement ${id}`
		)
		check(
			purpose !== "DistributionReturn",
			`Movement ${id} returns a distribution, which this ledger can't hold`
		)
		check(movement.direction === "Outflow", `Movement ${id} is not money out`)
		const amount = int(movement, "amount")
		check(sum(uses.map((row) => int(row, "amount"))) === amount, `Movement ${id} is not allocated exactly`)
		const sentOn = int(movement, "paidOn")
		const reference = text(one(references(id), `Mercury reference of movement ${id}`), "reference")
		const mercury = isUuid(reference)
			? remap(reference, sentOn, amount, purpose === "RothRemittance")
			: reference
		check(
			isTrackingId(mercury),
			`Movement ${id} has reference ${mercury}, neither a Tracking ID nor a receipt UUID`
		)
		const sources = uses.flatMap((use) => funding(text(use, "id")))
		const wagesOf = (ids: readonly string[]) => only(ids.map(wageOf), `paycheck for movement ${id}`)
		switch (purpose) {
			case "PayrollCash":
				facts.Transfer.push({ mercury, sentOn, kind: "NetPay" })
				facts.NetPay.push({
					transfer: mercury,
					wage: wagesOf(uses.flatMap((use) => payroll(text(use, "id")).map((row) => text(row, "wage")))),
					amount
				})
				break
			case "RothRemittance":
				facts.Transfer.push({ mercury, sentOn, kind: "RothDeferral" })
				facts.RothDeferral.push({
					transfer: mercury,
					wage: wagesOf(
						sources.flatMap((source) => funded(text(source, "contribution")).map((row) => text(row, "wage")))
					),
					amount
				})
				break
			case "OwnerDistribution": {
				const afterTax = sources.filter((source) => source.source === "EmployeeAfterTax")
				if (afterTax.length === 0) {
					facts.Transfer.push({ mercury, sentOn, kind: "Distribution" })
					facts.Distribution.push({ transfer: mercury, amount })
					break
				}
				check(
					sum(afterTax.map((row) => int(row, "amount"))) === amount,
					`Movement ${id} only partly funds after-tax contributions`
				)
				const year = only(
					afterTax.map((source) =>
						text(contributions.get(text(source, "contribution")) ?? fail("No contribution"), "year")
					),
					`contribution year for movement ${id}`
				)
				facts.Transfer.push({ mercury, sentOn, kind: "AfterTax" })
				facts.AfterTax.push({ transfer: mercury, year: BigInt(year), amount })
				break
			}
			case "TaxPayment": {
				const payment = text(
					one(
						uses.flatMap((use) => taxes(text(use, "id"))),
						`tax payment of movement ${id}`
					),
					"payment"
				)
				facts.Transfer.push({ mercury, sentOn, kind: "Tax" })
				facts.TaxDebit.push({ transfer: mercury, payment: tracker(payment) })
				break
			}
			default:
				fail(`Movement ${id} is a ${purpose}, which this ledger can't hold`)
		}
	}
}

// Tax payments: every referenced payment, the two IRS debits the old ledger
// never saw, the two TWC payments made outside Mercury, and three penalties.
const accountOf = new Map(
	rows("TaxAccount").map((row) => {
		const family = text(row, "family")
		const account = { Federal941: "Federal941", Federal940: "Federal940", TexasUnemployment: "TexasUI" }[
			family
		]
		return [
			text(row, "id"),
			(account ?? fail(`Unknown account family ${family}`)) as (typeof S.TaxAccount.handles)[number]
		]
	})
)
const legacyTwc: Readonly<Record<string, (typeof S.LegacyTwcPayment.handles)[number]>> = {
	"37834317": "TWC_37834317",
	"39613546": "TWC_39613546"
}
const unseenIrs = ["270665473829439", "270667581302337"]
const usedTracking = () => new Set(facts.Transfer.map((row) => row.mercury))
{
	const reconciliations = index("PaymentReconciliation", "payment")
	check(rows("PaymentAdjustment").length === 0, "Old payment adjustments exist; this ledger can't hold them")
	for (const payment of rows("TaxPayment")) {
		const id = text(payment, "id")
		const amount = int(payment, "amount")
		if (amount === 0n) continue
		const account = accountOf.get(text(payment, "account")) ?? fail(`Payment ${id} has no account`)
		const periods = reconciliations(id).map((row) => interval(row, "period"))
		const period = only(
			periods.map((span) =>
				formatPeriod(account === "Federal940" ? yearSpan(yearOf(span.start)) : quarterOf(span.start))
			),
			`period of payment ${id}`
		)
		const span = parsePeriod(period)
		check(
			periods.every((value) => value.start >= span.start && value.end <= span.end),
			`Payment ${id} reconciles across periods`
		)
		const tracked = tracker(id)
		const initiatedOn = int(payment, "sentOn")
		const base = { tracker: tracked, account, kind: "Deposit" as const, period: span, amount, initiatedOn }
		if (facts.TaxDebit.some((row) => row.payment === tracked)) {
			facts.TaxPayment.push({ ...base, funding: "Mercury" })
		} else if (unseenIrs.includes(tracked)) {
			const used = usedTracking()
			const debit = one(
				sent.filter(
					(row) =>
						irs.test(row.payee) &&
						row.amount === -amount &&
						row.date >= initiatedOn &&
						!used.has(row.tracking)
				),
				`IRS debit for EFT ${tracked}`
			)
			const confirmed = one(
				eftps.rows.filter((row) => row.eft === tracked),
				`eftps.csv row for EFT ${tracked}`
			)
			check(
				confirmed.trace === debit.tracking,
				`EFT ${tracked}: eftps.csv trace ${confirmed.trace} is not ${debit.tracking}`
			)
			facts.TaxPayment.push({ ...base, funding: "Mercury" })
			facts.Transfer.push({ mercury: debit.tracking, sentOn: debit.date, kind: "Tax" })
			facts.TaxDebit.push({ transfer: debit.tracking, payment: tracked })
		} else {
			const legacy = legacyTwc[tracked] ?? fail(`Payment ${tracked} has no Mercury debit`)
			facts.TaxPayment.push({ ...base, funding: "OutsideMercury" })
			facts.OutsideMercury.push({ payment: tracked, legacy })
		}
	}
	// Bad-check penalties, each 2% of a dishonored debit, paid by Mercury debit.
	const form = eftps.named(/tax form|^form$/i)
	const taxPeriod = eftps.named(/tax period|^period$/i)
	for (const penalty of [
		{ on: "2025-12-11", amount: "28.17", trace: "061036010012362" },
		{ on: "2026-07-02", amount: "28.17", trace: "061036010018731" },
		{ on: "2026-09-10", amount: "35.21", trace: "061036010003051" }
	]) {
		const row = one(
			eftps.rows.filter((entry) => entry.trace === penalty.trace),
			`eftps.csv row for trace ${penalty.trace}`
		)
		const debit = one(
			sent.filter((entry) => entry.tracking === penalty.trace),
			`mercury.csv row for trace ${penalty.trace}`
		)
		check(
			debit.amount === -cents(penalty.amount),
			`Penalty ${penalty.trace} is not ${penalty.amount} in mercury.csv`
		)
		const formName = cell(row.record, form)
		facts.TaxPayment.push({
			tracker: row.eft,
			account: /940/.test(formName) ? "Federal940" : "Federal941",
			kind: "Penalty",
			period: eftpsPeriod(cell(row.record, taxPeriod), formName),
			amount: cents(penalty.amount),
			initiatedOn: parseDate(penalty.on),
			funding: "Mercury"
		})
		facts.Transfer.push({ mercury: penalty.trace, sentOn: debit.date, kind: "Tax" })
		facts.TaxDebit.push({ transfer: penalty.trace, payment: row.eft })
	}
}

// Plan distributions as the 2025 1099-Rs report them. After-tax conversions
// (AfterTax, G) are implied by the AfterTax transfers and only checked.
const impliedAfterTax: { year: bigint; gross: bigint }[] = []
{
	const reports = new Map(rows("RetirementReport").map((row) => [text(row, "id"), row] as const))
	const accounts = new Map(rows("PlanAccount").map((row) => [text(row, "id"), text(row, "kind")] as const))
	for (const reported of rows("Reported1099R")) {
		const year = int(reports.get(text(reported, "report")) ?? fail("No retirement report"), "year")
		const account = accounts.get(text(reported, "account")) ?? fail("No plan account")
		const code = text(reported, "distributionCode")
		const gross = int(reported, "gross")
		if (account === "AfterTax" && code === "G") {
			impliedAfterTax.push({ year, gross })
			continue
		}
		const move = `${account}_${code}`
		check(
			["Pretax_G", "Pretax_H", "AfterTax_H", "Roth_G", "Roth_H"].includes(move),
			`A ${move} 1099-R can't be held`
		)
		facts.PlanDistribution.push({
			year,
			move: move as (typeof S.PlanMove.handles)[number],
			gross,
			taxable: int(reported, "taxable")
		})
	}
}

// Filings: the submitted ones. Grandfathered filings become Prior; the 941-X
// becomes the Correction of its 941; the rest keep how they were filed.
const formOf: Readonly<Record<string, S.FormHandle | "F941X">> = {
	F941: "F941",
	F941X: "F941X",
	F940: "F940",
	TexasUnemployment: "C3",
	W2SSA: "W3",
	W2Employee: "W2",
	F1099RIRS: "F1096",
	F1099RRecipient: "F1099R"
}
type Submitted = { form: S.FormHandle | "F941X"; period: Span; how: string; submission: Row; version: Row }
const submitted: Submitted[] = (() => {
	const rejected = new Set(rows("Rejection").map((row) => text(row, "submission")))
	const versions = new Map(rows("FilingVersion").map((row) => [text(row, "id"), row] as const))
	const filings = new Map(rows("Filing").map((row) => [text(row, "id"), row] as const))
	return rows("Submission")
		.filter((row) => !rejected.has(text(row, "id")))
		.map((submission) => {
			const version = versions.get(text(submission, "version")) ?? fail("No filing version")
			const filing = filings.get(text(version, "filing")) ?? fail("No filing")
			const form = formOf[text(filing, "form")] ?? fail(`Unknown form ${text(filing, "form")}`)
			return {
				form,
				period: interval(filing, "period"),
				how: text(submission, "method"),
				submission,
				version
			}
		})
})()
const legacyName = (form: S.FormHandle, period: Span) => `${form}_${formatPeriod(period)}`
const filings = {
	digital: index("DigitalSubmission", "submission"),
	reference: index("DigitalReference", "submission"),
	mailed: index("CertifiedMailSubmission", "submission"),
	mailing: new Map(rows("CertifiedMailing").map((row) => [text(row, "id"), row] as const))
}
const mailingOf = (submission: Row) =>
	filings.mailing.get(
		text(one(filings.mailed(text(submission, "id")), "certified mailing of a submission"), "mailing")
	) ?? fail("No certified mailing")
const deferredFigures: { id: Uuid; form: S.FormHandle; period: Span; snapshot?: string }[] = []
const corrections: { period: Span; mailedOn: bigint; tracking: string }[] = []
for (const filing of submitted) {
	const key = `${filing.form} ${formatPeriod(filing.period)}`
	check(
		submitted.filter((other) => other.form === filing.form && sameSpan(other.period, filing.period))
			.length === 1,
		`${key} was submitted more than once`
	)
	if (filing.form === "F941X") {
		check(filing.how === "CertifiedMail", `${key} was not mailed`)
		const mailing = mailingOf(filing.submission)
		corrections.push({
			period: filing.period,
			mailedOn: int(mailing, "mailedOn"),
			tracking: text(mailing, "number")
		})
		continue
	}
	const form = filing.form
	const id = filingId(form, filing.period)
	if (filing.how === "Grandfathered") {
		const legacy = LegacyFiling.handles.find((handle) => handle === legacyName(form, filing.period))
		const row = legacy ?? fail(`${key} is grandfathered but not one of the 15 legacy filings`)
		check(sameSpan(LegacyFiling.axioms[row].period, filing.period), `${row} names another period`)
		facts.Filing.push({ id, form, period: filing.period, method: "Prior" })
		facts.Prior.push({ filing: id, legacy: row })
		continue
	}
	if (filing.how === "Digital") {
		const digital = one(filings.digital(text(filing.submission, "id")), `digital submission of ${key}`)
		const confirmation = text(
			one(filings.reference(text(filing.submission, "id")), `confirmation of ${key}`),
			"value"
		)
		facts.Filing.push({ id, form, period: filing.period, method: "Electronic" })
		facts.Electronic.push({ filing: id, on: int(digital, "submittedOn"), confirmation })
	} else if (filing.how === "CertifiedMail") {
		const mailing = mailingOf(filing.submission)
		facts.Filing.push({ id, form, period: filing.period, method: "CertifiedMail" })
		facts.CertifiedMail.push({
			filing: id,
			mailedOn: int(mailing, "mailedOn"),
			tracking: text(mailing, "number")
		})
	} else fail(`${key} was submitted by ${filing.how}`)
	const prepared = rows("PreparedVersion").find((row) => row.version === filing.version.id)
	deferredFigures.push({
		id,
		form,
		period: filing.period,
		...(prepared === undefined ? {} : { snapshot: text(prepared, "snapshot") })
	})
}
// Figures depend on every fact above, payments included.
const frozen = facts as Db.Facts
for (const filing of deferredFigures) {
	const lines = figures(filing.form, periodOf(frozen, filing.period))
	facts.FiledFigures.push(...[...lines].map(([line, value]) => ({ filing: filing.id, line, value })))
	if (filing.snapshot === undefined) continue
	// What was prepared then must be what the ledger computes now.
	const totals = (JSON.parse(filing.snapshot) as { figures?: { totals?: Row } }).figures?.totals
	if (totals === undefined) continue
	const period = periodOf(frozen, filing.period)
	check(
		int(totals, "gross") === sum(period.wages.map(grossOf)),
		`${filing.form} ${formatPeriod(filing.period)}: prepared gross differs`
	)
	const assessed = (totals.assessed ?? []) as Row[]
	const prepared = (name: string) => assessed.find((row) => row.component === name)
	for (const [name, now] of [
		["FIT", sum(period.wages.map((wage) => wage.fit))],
		["EmployeeSS", sum(period.wages.map((wage) => wage.ss))],
		["EmployeeMedicare", sum(period.wages.map((wage) => wage.medicare))]
	] as const) {
		const row = prepared(name)
		if (row !== undefined)
			check(
				int(row, "amount") === now,
				`${filing.form} ${formatPeriod(filing.period)}: prepared ${name} differs`
			)
	}
}
for (const correction of corrections) {
	const filing = facts.Filing.find((row) => row.form === "F941" && sameSpan(row.period, correction.period))
	const id = (filing ?? fail(`The 941-X for ${formatPeriod(correction.period)} has no 941`)).id
	facts.Correction.push({ filing: id, mailedOn: correction.mailedOn, tracking: correction.tracking })
	const current = figures("F941", periodOf(frozen, correction.period))
	facts.CorrectedFigures.push(
		...correctable.map((line) => ({ filing: id, line, value: current.get(line) ?? 0n }))
	)
}

// ── checks ─────────────────────────────────────────────────────────────────

const asOf = parseDate("2026-10-02")
const spanOfFile = (name: string) => parsePeriod(name.replace(/\.json$/, ""))

// Every paycheck is settled.
for (const paycheck of paychecks(frozen)) {
	const day = formatDate(paycheck.wage.paidOn.start)
	check(
		paycheck.sentNet === paycheck.owedNet,
		`${day}: sent ${$(paycheck.sentNet)} of ${$(paycheck.owedNet)} net pay`
	)
	check(
		paycheck.sentRoth === paycheck.wage.roth,
		`${day}: sent ${$(paycheck.sentRoth)} of ${$(paycheck.wage.roth)} Roth`
	)
}

// Mercury rows and transfers correspond one to one by Tracking ID.
{
	const rowsByTracking = new Map<string, Bank[]>()
	for (const row of sent.filter(tracked))
		rowsByTracking.set(row.tracking, [...(rowsByTracking.get(row.tracking) ?? []), row])
	const amounts = new Map<string, bigint>()
	for (const arm of [...facts.NetPay, ...facts.RothDeferral, ...facts.AfterTax, ...facts.Distribution])
		amounts.set(arm.transfer, arm.amount)
	for (const debit of facts.TaxDebit)
		amounts.set(debit.transfer, facts.TaxPayment.find((row) => row.tracker === debit.payment)?.amount ?? 0n)
	const shifted: string[] = []
	for (const transfer of facts.Transfer) {
		const row = one(
			rowsByTracking.get(transfer.mercury) ?? [],
			`Sent mercury.csv row for ${transfer.mercury}`
		)
		check(
			row.amount === -(amounts.get(transfer.mercury) ?? 0n),
			`${transfer.mercury}: mercury.csv says ${$(-row.amount)}`
		)
		if (row.date !== transfer.sentOn)
			shifted.push(`${transfer.mercury} ${formatDate(transfer.sentOn)} → ${formatDate(row.date)}`)
	}
	const recorded = usedTracking()
	const missing = [...rowsByTracking.keys()].filter((tracking) => !recorded.has(tracking))
	check(missing.length === 0, `mercury.csv rows with no transfer: ${missing.join(", ")}`)
	const ignored = mercury.filter((row) => !(row.status.toLowerCase() === "sent" && tracked(row)))
	log(`mercury.csv: ${facts.Transfer.length} transfers matched; ${ignored.length} other rows ignored`)
	if (shifted.length > 0)
		log(`mercury.csv dates one UTC day off the ledger, kept as recorded: ${shifted.join("; ")}`)
}

// Every golden period reproduces gross, FIT, each tax, Roth and cash.
{
	const golden = path.join(inputs, "golden")
	const files = readdirSync(golden).filter((name) => /^\d{4}(Q[1-4])?\.json$/.test(name))
	check(files.length === 9, `Expected 9 golden reports in ${golden}, found ${files.length}`)
	for (const file of files.sort()) {
		const span = spanOfFile(file)
		const label = formatPeriod(span)
		const totals = (JSON.parse(readFileSync(path.join(golden, file), "utf8")) as { totals: Row }).totals
		const total = (list: string, key: string, name: string) => {
			const row = ((totals[list] ?? []) as Row[]).find((entry) => entry[key] === name)
			return row === undefined
				? undefined
				: { amount: cents(text(row, "amount")), complete: row.complete !== false }
		}
		const period = periodOf(frozen, span)
		const olds = oldWages.filter((wage) => wage.day >= span.start && wage.day < span.end)
		const owed = paychecks(frozen).filter(
			(paycheck) => paycheck.wage.paidOn.start >= span.start && paycheck.wage.paidOn.start < span.end
		)
		const expect = (what: string, golden: bigint | undefined, now: bigint) => {
			if (golden !== undefined) check(golden === now, `${label} ${what}: old ${$(golden)}, new ${$(now)}`)
		}
		check(
			Number(totals.wageCount) === olds.length,
			`${label}: old ${String(totals.wageCount)} paychecks, imported ${olds.length}`
		)
		expect("gross", cents(text(totals, "gross")), sum(period.wages.map(grossOf)))
		expect("cash", cents(text(totals, "cash")), sum(owed.map((paycheck) => paycheck.owedNet)))
		const ss = sum(period.wages.map((wage) => wage.ss))
		const medicare = sum(period.wages.map((wage) => wage.medicare))
		expect("FIT", total("assessed", "component", "FIT")?.amount, sum(period.wages.map((wage) => wage.fit)))
		expect("employee SS", total("assessed", "component", "EmployeeSS")?.amount, ss)
		expect("employer SS", total("assessed", "component", "EmployerSS")?.amount, ss)
		expect("employee Medicare", total("assessed", "component", "EmployeeMedicare")?.amount, medicare)
		expect("employer Medicare", total("assessed", "component", "EmployerMedicare")?.amount, medicare)
		// FUTA and SUTA are taxed per period now; the old per-paycheck amounts
		// only check that the old arithmetic was read right.
		for (const [name, of] of [
			["FUTA", (wage: OldWage) => wage.futa],
			["SUTA", (wage: OldWage) => wage.suta]
		] as const) {
			const amounts = olds.map(of)
			const row = total("assessed", "component", name)
			if (row?.complete && amounts.every((amount) => amount !== undefined))
				expect(`${name} as assessed`, row.amount, sum(amounts as bigint[]))
		}
		expect(
			"Roth",
			total("deducted", "kind", "Roth")?.amount ?? 0n,
			sum(period.wages.map((wage) => wage.roth))
		)
		const taxable = (name: string, now: bigint) => {
			const row = total("taxable", "component", name)
			if (row?.complete) expect(`${name} taxable wages`, row.amount, now)
		}
		const slices = (base: (rules: Rules) => bigint) =>
			sum(period.wages.map((wage) => under(wage.earnings, base(period.rules(wage)))))
		taxable(
			"EmployeeSS",
			slices((rules) => rules.ssBase)
		)
		taxable(
			"FUTA",
			slices((rules) => rules.futaBase)
		)
		taxable(
			"SUTA",
			slices((rules) => rules.sutaBase)
		)
		log(`${label}: the old report reproduces`)
	}
}

// The one calendar, against the old ledger's federal business days.
{
	const federal = rows("BusinessDay").filter((row) => row.authority === "FederalDC")
	const differ = federal
		.map((row) => ({ day: interval(row, "span").start, eligible: row.eligible === true }))
		.filter((row) => isBusinessDay(row.day) !== row.eligible)
	log(
		differ.length === 0
			? `calendar: agrees with all ${federal.length} old federal business-day rows`
			: `calendar: differs from the old rows on ${differ.map((row) => `${formatDate(row.day)} (old: ${row.eligible ? "open" : "closed"})`).join(", ")}`
	)
}

// No historical money is owed and nothing blocks payroll.
{
	const { blockers, credits } = obligations(frozen, asOf)
	check(blockers.length === 0, `Open as of 2026-10-02: ${blockers.map((item) => item.what).join("; ")}`)
	log(
		`credits: ${credits.map((row) => `${row.account} ${formatPeriod(row.period)} ${$(row.credit)}`).join("; ") || "none"}`
	)
	const view = status(frozen, asOf)
	check(!view.upcoming.some((item) => /941-X/.test(item.what)), "A 941-X is pending")
	check(
		view.mismatches.length === 0,
		`Filed figures differ: ${JSON.stringify(view.mismatches.map((row) => row.line))}`
	)
}

// The real figures, which only the owner's data has.
const anchors = () => {
	const dollars = (value: bigint, expected: string, what: string) =>
		check(value === cents(expected), `${what}: ${$(value)}, expected ${expected}`)
	check(
		rows("Wage").length === 67 && facts.Wage.length === 63,
		`${rows("Wage").length} old wages became ${facts.Wage.length}`
	)
	for (const day of ["2026-06-04", "2026-09-09", "2026-09-16", "2026-10-02"])
		check(oldWages.filter((wage) => wage.day === parseDate(day)).length === 2, `${day} is not a merged pair`)
	const gross = (year: number) => sum(facts.Wage.filter((wage) => wage.year === BigInt(year)).map(grossOf))
	dollars(gross(2025), "87452.06", "2025 gross")
	dollars(gross(2026), "111028.55", "2026 gross")
	dollars(
		sum(facts.Wage.filter((wage) => wage.year === 2026n).map((wage) => wage.roth)),
		"24500.00",
		"2026 Roth"
	)
	const q3 = figures("F941", periodOf(frozen, quarterSpan(2026, 3)))
	dollars(q3.get("F941_2") ?? 0n, "38594.82", "941 2026Q3 wages")
	dollars(q3.get("F941_12") ?? 0n, "5905.08", "941 2026Q3 line 12")
	const recovery = (from: string, by: string, amount: string) =>
		dollars(
			facts.Recovery.find(
				(row) => row.wage === wageId(parseDate(from)) && row.recoveredBy === wageId(parseDate(by))
			)?.amount ?? 0n,
			amount,
			`recovery ${from} → ${by}`
		)
	recovery("2026-06-01", "2026-09-16", "389.39")
	recovery("2026-06-04", "2026-09-16", "425.87")
	recovery("2026-09-09", "2026-09-16", "243.71")
	dollars(sum(facts.Recovery.map((row) => row.amount)), "1058.97", "recoveries")
	check(remapped.length === 4, `${remapped.length} receipt UUIDs remapped`)
	check(facts.Transfer.length === 153, `${facts.Transfer.length} transfers`)
	check(facts.TaxPayment.length === 24, `${facts.TaxPayment.length} tax payments`)
	check(
		facts.Filing.length === 18 - 1 && facts.Correction.length === 1 && facts.Prior.length === 15,
		"18 filings"
	)
	const distributed = (year: number) =>
		sum(
			[...facts.Distribution, ...facts.AfterTax]
				.filter(
					(arm) => yearOf(facts.Transfer.find((row) => row.mercury === arm.transfer)?.sentOn ?? 0n) === year
				)
				.map((arm) => arm.amount)
		)
	dollars(distributed(2025), "200871.27", "2025 distributions")
	dollars(distributed(2026), "169183.02", "2026 distributions")
	const afterTax2025 = sum(facts.AfterTax.filter((row) => row.year === 2025n).map((row) => row.amount))
	dollars(afterTax2025, "40667.00", "2025 after-tax")
	check(
		impliedAfterTax.length === 1 && impliedAfterTax[0]?.gross === afterTax2025,
		"The 2025 after-tax 1099-R is not the after-tax transfers"
	)
	const move = (name: string) => facts.PlanDistribution.find((row) => row.year === 2025n && row.move === name)
	dollars(move("Pretax_G")?.gross ?? 0n, "10580.45", "2025 Pretax G gross")
	dollars(move("Pretax_G")?.taxable ?? 0n, "10580.45", "2025 Pretax G taxable")
	dollars(move("Roth_H")?.gross ?? 0n, "42964.08", "2025 Roth H gross")
	dollars(move("Roth_H")?.taxable ?? 1n, "0.00", "2025 Roth H taxable")
	const election = (year: bigint) => facts.Election.find((row) => row.year === year)
	check(
		election(2025n)?.roth === 0n &&
			election(2025n)?.afterTax === cents("70000.00") &&
			election(2025n)?.signedOn === parseDate("2025-06-16"),
		"2025 election"
	)
	check(
		election(2026n)?.roth === cents("24500.00") &&
			election(2026n)?.afterTax === cents("47500.00") &&
			election(2026n)?.signedOn === parseDate("2026-09-10"),
		"2026 election"
	)
	const filed = (form: S.FormHandle, period: string) =>
		facts.Filing.find((row) => row.form === form && sameSpan(row.period, parsePeriod(period)))?.id
	check(
		facts.Electronic.some(
			(row) =>
				row.filing === filed("C3", "2026Q3") &&
				row.confirmation === "40679134" &&
				row.on === parseDate("2026-10-01")
		),
		"C-3 2026Q3"
	)
	check(
		facts.CertifiedMail.some(
			(row) =>
				row.filing === filed("F941", "2026Q3") &&
				row.tracking === "70201810000002650240" &&
				row.mailedOn === parseDate("2026-10-02")
		),
		"941 2026Q3"
	)
	check(
		facts.Correction.some(
			(row) =>
				row.filing === filed("F941", "2026Q2") &&
				row.tracking === "9589071052704586360357" &&
				row.mailedOn === parseDate("2026-09-10")
		),
		"941-X 2026Q2"
	)
	const penalty = facts.TaxPayment.find((row) => row.tracker === "270574554735721")
	check(
		penalty?.kind === "Penalty" &&
			penalty.account === "Federal941" &&
			sameSpan(penalty.period, quarterSpan(2025, 4)),
		"The 2025-12-11 penalty is not EFT 270574554735721 for 941 2025Q4"
	)
	const { credits } = obligations(frozen, asOf)
	for (const quarter of [2, 3])
		check(
			credits.some(
				(row) =>
					row.account === "Federal941" &&
					sameSpan(row.period, quarterSpan(2026, quarter)) &&
					row.credit === 5n
			),
			`941 2026Q${quarter} has no $0.05 credit`
		)
	const deposit = status(frozen, asOf).upcoming.find(
		(item) => item.what === "941 deposit" && item.period && sameSpan(item.period, parsePeriod("2026-10"))
	)
	check(
		deposit?.amount === cents("649.12") &&
			deposit.opensOn === parseDate("2026-11-01") &&
			deposit.dueOn === parseDate("2026-11-16"),
		"The October deposit is not 649.12 due 2026-11-16"
	)
	log("anchors: every real figure holds")
}
if (withAnchors) anchors()

// ── the ledger ─────────────────────────────────────────────────────────────

const layer = NativeRuntime.layer()
const execute = async <A>(effect: Effect.Effect<A, unknown, NativeRuntime>) => {
	const exit = await Effect.runPromiseExit(effect.pipe(Effect.provide(layer)))
	return Exit.isSuccess(exit) ? exit.value : fail(JSON.stringify(describeCause(exit.cause)))
}
const edits = (Object.keys(facts) as Db.Name[]).flatMap((name) =>
	Db.insert(name, ...(facts[name] as never[]))
)
const staging = path.join(inputs, "ledger")
await fs.rm(staging, { recursive: true, force: true })
await execute(Db.build(staging, { edits, result: {} }))
log(`laws: ${edits.length} facts admitted`)

// Done when: status, the 2026 tax payments, and the next paycheck's quote.
const now = (await execute(run("status", { asOf: "2026-10-02" }, staging))) as ReturnType<typeof status>
check(now.blockers.length === 0, "The new ledger has blockers")
const listed = ((await execute(run("report", { year: 2026 }, staging))) as ReturnType<typeof report>)
	.taxPayments
check(
	listed.length === facts.TaxPayment.filter((row) => row.initiatedOn < yearSpan(2026).end).length,
	"Tax payments missing"
)
check(
	listed.every((row) => (row.mercury === "outside Mercury") === Object.hasOwn(legacyTwc, row.tracker)),
	"Only the legacy TWC payments are outside Mercury"
)
for (const row of listed)
	log(`  ${row.tracker} ${row.account} ${formatPeriod(row.period)} ${$(row.amount)} ${row.mercury}`)
const quote = (await execute(
	run("payroll.quote", { paidOn: "2026-10-09", input: { by: "plan" } }, staging)
)) as {
	gross: bigint
}
log(`payroll.quote 2026-10-09: ${$(quote.gross)}`)
if (withAnchors) check(quote.gross === cents("747.62"), "The 2026-10-09 quote is not 747.62")

if (dryRun) {
	log(`dry run: the new ledger is at ${staging}; nothing else changed`)
	process.exit(0)
}

// Move the old ledger aside, then restore the new one from its own export.
const backup = Db.backupOf(ledger)
const exported = (await execute(run("export", { out: backup }, staging))) as { facts: bigint }
const binding = path.join(privateDir, "binding.json")
const store = existsSync(binding)
	? path.resolve(
			Db.repositoryRoot,
			(JSON.parse(readFileSync(binding, "utf8")) as { directory: string }).directory
		)
	: ledger
if (existsSync(store)) await fs.rename(store, aside)
if (existsSync(binding)) await fs.rename(binding, path.join(inputs, "old-binding.json"))
const requests = path.join(privateDir, "requests")
if (existsSync(requests)) await fs.rename(requests, path.join(inputs, "old-requests"))
check(!existsSync(ledger), `${ledger} still exists and is not the old ledger`)
await execute(run("import", { file: backup }, ledger))
const again = path.join(inputs, "reexport.json")
await execute(run("export", { out: again }, ledger))
check(readFileSync(again, "utf8") === readFileSync(backup, "utf8"), "The imported ledger exports differently")
await fs.rm(again)
await fs.rm(staging, { recursive: true, force: true })
log(`cut over: ${exported.facts} facts in ${ledger}; old ledger at ${aside}; backup at ${backup}`)
