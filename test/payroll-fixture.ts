import assert from "node:assert/strict"
import { ChangeSet, type Fact, type Uuid } from "@bjornpagen/bumbledb"
import { Effect } from "effect"
import { statementWriter } from "../src/commands.ts"
import { periodSpan } from "../src/core/time.ts"
import { MAX_U64, mintId } from "../src/core/values.ts"
import { ensureFilings } from "../src/filing-coverage.ts"
import { installCalendarFacts } from "../src/policy/calendar.ts"
import type { LedgerHistory } from "../src/runtime.ts"
import { componentPolicy, components, formPolicy, forms } from "../src/schema/vocabulary.ts"
import * as S from "../src/schema.ts"
import { seedAnnualPolicies } from "./annual-fixture.ts"
import { apply, say } from "./native-history.ts"

export const evidence = "Synthetic qualification only; not executable live tax policy"
const rates = {
	EmployeeSS: { cap: 18450000n, numerator: 620n },
	EmployerSS: { cap: 18450000n, numerator: 620n },
	EmployeeMedicare: { cap: MAX_U64, numerator: 145n },
	EmployerMedicare: { cap: MAX_U64, numerator: 145n },
	FUTA: { cap: 700000n, numerator: 60n },
	SUTA: { cap: 900000n, numerator: 270n }
} as const
type BandComponent = keyof typeof rates

export const setupPayroll = (history: LedgerHistory, stateNumerator = 270n, identity = 0) =>
	Effect.gen(function* () {
		const draft = yield* ChangeSet.builder(S.ledger)
		const business = yield* mintId
		const employee = yield* mintId
		const release = yield* mintId
		yield* draft.insert(S.Business, [
			{
				id: business,
				name: "Synthetic",
				ein: `00-${String(identity).padStart(7, "0")}`,
				state: "TX",
				timeZone: "America/Chicago"
			}
		])
		yield* draft.insert(S.Employee, [
			{
				id: employee,
				business,
				firstName: "Test",
				lastName: "Only",
				ssn: "000-00-0000",
				address: "Synthetic",
				filingStatus: "Single"
			}
		])
		yield* draft.insert(S.PolicyRelease, [
			{ id: release, sha256: `test-policy-${identity}`, title: evidence, evidence: say(evidence) }
		])
		const domain = yield* mintId
		const depositor = yield* mintId
		yield* draft.insert(S.MonthlyDepositor, [
			{ id: depositor, business, valid: periodSpan(2026, "Year"), evidence: say(evidence) }
		])
		yield* draft.insert(S.SupportedPayrollDomain, [
			{
				id: domain,
				release,
				state: "TX",
				federalDepositLimit: 10000000n,
				valid: periodSpan(2026, "Year"),
				evidence: say(evidence)
			}
		])
		const federal = yield* installCalendarFacts(draft, statementWriter(draft), release, {
			authority: "FederalDC",
			fromYear: 2026,
			throughYear: 2027,
			holidays: [],
			evidence
		})
		const texas = yield* installCalendarFacts(draft, statementWriter(draft), release, {
			authority: "Texas",
			fromYear: 2026,
			throughYear: 2027,
			holidays: [],
			evidence
		})
		const canonical = federal.periods.find((row) => row.kind === "Year" && row.year === 2026n)
		assert.ok(canonical)
		const calendar = canonical.id
		const rules = new Map<
			BandComponent,
			{ version: Uuid; schedule: Uuid; scope: Uuid; support: Uuid; bands: Fact<typeof S.TaxBand>[] }
		>()
		const scopes = new Map<string, Uuid>()
		const supports = new Map<string, Uuid>()
		for (const component of components) {
			if (component === "FIT") continue
			const program = componentPolicy[component].program
			let scope = scopes.get(program)
			if (!scope) {
				scope = yield* mintId
				scopes.set(program, scope)
				yield* draft.insert(S.TaxBaseScope, [
					{ id: scope, business, employee, program, year: 2026n, calendar, span: periodSpan(2026, "Year") }
				])
				if (program === "StateUnemployment") yield* draft.insert(S.StateBaseScope, [{ scope, state: "TX" }])
				const support = yield* mintId
				supports.set(program, support)
				yield* draft.insert(S.SupportedProgram, [
					{
						id: support,
						domain,
						program,
						eligible: { start: 0n, end: program === "Medicare" ? 20000000n : MAX_U64 },
						evidence: say(evidence)
					}
				])
			}
			const support = supports.get(program)
			assert.ok(support)
			const version = yield* mintId
			const schedule = yield* mintId
			yield* draft.insert(S.RateSchedule, [
				{ id: schedule, denominator: 10000n, domain: { start: 0n, end: MAX_U64 }, evidence: say(evidence) }
			])
			yield* draft.insert(S.PolicyCoverage, [
				{ release, business, component, span: periodSpan(2026, "Year") }
			])
			yield* draft.insert(S.RateVersion, [
				{
					id: version,
					release,
					business,
					component,
					valid: periodSpan(2026, "Year"),
					schedule,
					evidence: say(evidence)
				}
			])
			if (component === "SUTA") {
				const notice = yield* mintId
				yield* draft.insert(S.EmployerRateNotice, [
					{
						id: notice,
						business,
						state: "TX",
						schedule,
						valid: periodSpan(2026, "Year"),
						evidence: say(evidence)
					}
				])
				yield* draft.insert(S.EmployerSchedule, [
					{ version, notice, business, schedule, valid: periodSpan(2026, "Year") }
				])
			}
			if (component === "FUTA") yield* draft.insert(S.FutaBasis, [{ version, evidence: say(evidence) }])
			const { cap } = rates[component]
			const numerator = component === "SUTA" ? stateNumerator : rates[component].numerator
			const bands: Fact<typeof S.TaxBand>[] = [
				{ id: yield* mintId, schedule, wages: { start: 0n, end: cap }, numerator, role: "WithinBase" }
			]
			if (cap !== MAX_U64)
				bands.push({
					id: yield* mintId,
					schedule,
					wages: { start: cap, end: MAX_U64 },
					numerator: 0n,
					role: "Excess"
				})
			yield* draft.insert(S.TaxBand, bands)
			rules.set(component, { version, schedule, scope, support, bands })
		}
		assert.equal((yield* apply(history, yield* draft.finish())).outcome.kind, "committed")
		const annual = yield* seedAnnualPolicies(history, business, release)
		return { business, employee, release, domain, depositor, rules, federal, texas, calendar, annual }
	})
export type PayrollFixture = Effect.Success<ReturnType<typeof setupPayroll>>

/** A configured ledger: bound policy, budget, accounts, deposits, filing rules and filings. */
export const readyPayroll = (history: LedgerHistory, identity = 0) =>
	Effect.gen(function* () {
		const fixture = yield* setupPayroll(history, 270n, identity)
		const draft = yield* ChangeSet.builder(S.ledger)
		const { business, employee, release } = fixture
		yield* draft.insert(S.PolicyBinding, [{ business, release, evidence: say(evidence) }])
		yield* draft.insert(S.AnnualBudget, [
			{ id: yield* mintId, employee, year: 2026n, limit: 20000000n, evidence: say(evidence) }
		])
		const accounts = []
		for (const family of S.AccountFamily.handles) {
			const account = yield* mintId,
				policy = yield* mintId
			const periodKind = family === "Federal941" ? "Month" : "Quarter"
			const authority = family === "TexasUnemployment" ? "Texas" : "FederalDC"
			const calendar = authority === "Texas" ? fixture.texas : fixture.federal
			accounts.push({ id: account, business, family, evidence })
			yield* draft.insert(S.TaxAccount, [{ id: account, business, family, evidence: say(evidence) }])
			yield* draft.insert(S.DepositPolicy, [
				{
					id: policy,
					release,
					business,
					account,
					family,
					periodKind,
					authority,
					dueRule: "FollowingMonthEnd",
					valid: periodSpan(2026, "Year"),
					evidence: say(evidence)
				}
			])
			for (const kind of S.CheckpointKind.handles)
				yield* draft.insert(S.DepositTrigger, [
					{
						policy,
						kind,
						actionable: { start: family === "Federal940" && kind === "Interim" ? 50001n : 1n, end: MAX_U64 }
					}
				])
			for (const period of calendar.periods.filter((row) => row.kind === periodKind && row.year === 2026n)) {
				yield* draft.insert(S.DepositCheckpoint, [
					{
						id: yield* mintId,
						policy,
						business,
						account,
						calendar: period.id,
						periodKind,
						span: period.span,
						year: 2026n,
						kind: period.ordinal === (periodKind === "Month" ? 12n : 4n) ? "Terminal" : "Interim",
						opensOn: period.span.end,
						dueOn: period.span.end + 15n,
						evidence: say(evidence)
					}
				])
			}
		}
		for (const form of forms.filter((form) => formPolicy[form].due !== "RecordedEvent"))
			yield* draft.insert(S.FilingRule, [
				{
					id: yield* mintId,
					release,
					form,
					authority: formPolicy[form].authority,
					periodKind: formPolicy[form].period,
					dueRule: "FollowingMonthEnd",
					evidence: say(evidence)
				}
			])
		assert.equal((yield* apply(history, yield* draft.finish())).outcome.kind, "committed")
		yield* ensureFilings({
			request: yield* mintId,
			business,
			throughYear: 2026,
			enrollment: { startsOn: "2026-09-01", evidence }
		})
		return { ...fixture, accounts }
	})
