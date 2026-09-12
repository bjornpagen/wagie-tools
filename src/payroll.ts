import type { Fact, IntervalValue, Uuid } from "@bjornpagen/bumbledb"
import { Effect, Schema } from "effect"
import { admitContribution } from "./bookkeeping.ts"
import { assessmentForSet, netCash } from "./calculations.ts"
import { businessCommand } from "./commands.ts"
import { epochDay, toCalendarDate, type UnixEpochDay } from "./core/time.ts"
import { entityId, json, mintId, Nonblank, Refusal, unsigned } from "./core/values.ts"
import { ensureFilingFacts } from "./filing-coverage.ts"
import { AmendmentDeadlineInput, revisionFilingFacts } from "./filings.ts"
import { ObservedAssessmentInput, observedSetFacts } from "./observations.ts"
import { approvedPoliciesAt } from "./policy/annual.ts"
import { currentRevisions, initialFederalAccruals, relationRows, rows } from "./queries.ts"
import { captureRecoveryClaims, recoveryFacts, settlePaycheck } from "./recoveries.ts"
import { type Draft, fingerprint, latest, parseStrict, resolveRequest, type Snapshot } from "./runtime.ts"
import { commandFields, Day, DayPoint, DaySpan, Id, inputField, inputFields } from "./schema/input.ts"
import { componentPolicy, components, withholdingPolicy } from "./schema/vocabulary.ts"
import * as S from "./schema.ts"
import { requirePayrollReady } from "./work.ts"

export const WorkInput = DaySpan
const SuppliedFIT = Schema.Struct({
	cents: inputField(S.ObservedAssessment.fields.amount),
	evidence: Nonblank
})
export const CalculateInput = Schema.Struct({
	...commandFields,
	...inputFields(S.AssessmentSet, ["employee"]),
	purpose: Schema.Union([
		Schema.Struct({
			kind: Schema.Literal("NewWage"),
			...inputFields(S.AssessmentSet, ["paidOn"], { paidOn: DayPoint }),
			grossCents: inputField(S.AssessmentSet.fields.gross),
			rothCents: inputField(S.ProposedWage.fields.roth),
			work: WorkInput
		}),
		Schema.Struct({
			kind: Schema.Literal("TaxRevision"),
			...inputFields(S.ProposedRevision, ["wage", "predecessor"]),
			sameDayBefore: Schema.Array(Id)
		})
	]),
	fit: SuppliedFIT,
	evidence: Nonblank
})
const BankInput = Schema.Struct({
	...inputFields(S.MercuryTransaction, ["reference"]),
	...inputFields(S.BankMovement, ["paidOn", "amount"], { paidOn: Day })
})
export const PostInput = Schema.Struct({
	...commandFields,
	calculation: Id,
	settlement: Schema.Union([
		Schema.Struct({ kind: Schema.Literal("Bank"), ...BankInput.fields }),
		Schema.Struct({ kind: Schema.Literal("NoTransfer") })
	])
})
export const ReviseInput = Schema.Struct({
	...commandFields,
	assessment: Schema.Union([
		Schema.Struct({ kind: Schema.Literal("Calculated"), calculation: Id }),
		Schema.Struct({
			kind: Schema.Literal("Observed"),
			...inputFields(S.ProposedRevision, ["wage", "predecessor"]),
			figures: ObservedAssessmentInput
		})
	]),
	amendments: Schema.optional(Schema.Array(AmendmentDeadlineInput))
})

const contains = (span: IntervalValue, day: bigint) => span.start <= day && day < span.end
function required<A>(value: A | undefined, code: string, message: string): A {
	if (value === undefined) throw new Refusal({ code, message })
	return value
}

/** Payroll rates never select a default release or a latest notice. The stored
 * active release and pay date select the exact dated policy facts.
 */
const policyAt = (snapshot: Snapshot, business: Uuid, day: UnixEpochDay) =>
	Effect.gen(function* () {
		const binding = required(
			(yield* relationRows(snapshot, S.PolicyBinding)).find((row) => row.business === business),
			"PolicyMissing",
			"Activate an evidenced policy release"
		)
		const domain = required(
			(yield* relationRows(snapshot, S.SupportedPayrollDomain)).find(
				(row) => row.release === binding.release && row.state === "TX" && contains(row.valid, day)
			),
			"PayrollPolicyMissing",
			"The selected policy does not support this pay date"
		)
		const calendar = required(
			(yield* relationRows(snapshot, S.CalendarPeriod)).find(
				(row) =>
					row.release === binding.release &&
					row.authority === "FederalDC" &&
					row.kind === "Year" &&
					contains(row.span, day)
			),
			"CalendarCoverageMissing",
			"Install the canonical pay-year calendar"
		)
		const approvals = yield* approvedPoliciesAt(snapshot, business, binding.release, day)
		return { release: binding.release, domain, calendar, approvals }
	})

/** Captures economic wages exactly once. A tax revision explicitly identifies
 * earlier same-day wages; UUID/recording order never substitutes for that fact.
 * All current programs use gross wages, independently of historical tax amounts.
 */
export const calculatePayroll = (payload: unknown) =>
	Effect.gen(function* () {
		const input = parseStrict(CalculateInput, payload),
			business = input.business,
			employee = input.employee
		return yield* businessCommand({
			request: input.request,
			business,
			action: "payroll calculate",
			input: payload,
			plan: ({ snapshot, draft, recordingDay }) =>
				Effect.gen(function* () {
					required(
						(yield* relationRows(snapshot, S.Employee)).find(
							(row) => row.id === employee && row.business === business
						),
						"EmployeeMissing",
						"Select an employee belonging to this business"
					)
					const allWages = (yield* relationRows(snapshot, S.Wage)).filter((row) => row.employee === employee)
					const purpose = input.purpose
					const target =
						purpose.kind === "TaxRevision"
							? required(
									allWages.find((row) => row.id === purpose.wage),
									"WageMissing",
									"The revision target is not this employee's wage"
								)
							: undefined
					const wageInput =
						purpose.kind === "NewWage"
							? { paidOn: purpose.paidOn, gross: purpose.grossCents }
							: required(target, "WageMissing", "Select an existing wage")
					const { paidOn, gross } = wageInput
					const payDay = epochDay(paidOn.start),
						year = toCalendarDate(payDay).year
					if (gross === 0n)
						return yield* Effect.fail(
							new Refusal({
								code: "PositiveGrossRequired",
								message: "New calculations require positive gross cents"
							})
						)
					const policy = yield* policyAt(snapshot, business, payDay)
					let predecessor: Fact<typeof S.AssessmentRevision> | undefined
					if (purpose.kind === "TaxRevision") {
						predecessor = required(
							(yield* rows(snapshot, currentRevisions, {})).find(
								(row) => row.id === purpose.predecessor && row.wage === target?.id
							),
							"RevisionNotCurrent",
							"Calculate against the wage's current revision"
						)
						if (
							new Set(purpose.sameDayBefore).size !== purpose.sameDayBefore.length ||
							purpose.sameDayBefore.some(
								(id) =>
									!allWages.some(
										(row) => row.id === id && row.id !== target?.id && row.paidOn.start === paidOn.start
									)
							)
						)
							return yield* Effect.fail(
								new Refusal({
									code: "SameDayContextInvalid",
									message: "Same-day predecessors must be distinct other wages for this employee and pay date"
								})
							)
					}
					const priorWages = allWages.filter(
						(row) =>
							row.year === BigInt(year) &&
							row.id !== target?.id &&
							(row.paidOn.start < paidOn.start ||
								(row.paidOn.start === paidOn.start &&
									(purpose.kind === "NewWage" || purpose.sameDayBefore.includes(row.id))))
					)
					const prior = priorWages.reduce((total, row) => unsigned(total + row.gross), 0n)
					const earning = { start: prior, end: unsigned(prior + gross) }
					const context = {
						wages: priorWages.map((row) => ({ wage: row.id, gross: row.gross, paidOn: row.paidOn })),
						purpose,
						sourceStamp: snapshot.stateStamp,
						evidence: input.evidence
					}
					const availableRules = (yield* relationRows(snapshot, S.RateVersion)).filter(
						(row) =>
							row.release === policy.release && row.business === business && contains(row.valid, payDay)
					)
					const availableScopes = (yield* relationRows(snapshot, S.TaxBaseScope)).filter(
						(row) => row.business === business && row.employee === employee && row.year === BigInt(year)
					)
					const availableSupports = (yield* relationRows(snapshot, S.SupportedProgram)).filter(
						(row) => row.domain === policy.domain.id
					)
					const set = yield* mintId,
						calculation = yield* mintId
					yield* draft.insert(S.AssessmentSet, [
						{ id: set, business, employee, paidOn, gross, origin: "Calculated" }
					])
					yield* draft.insert(S.PayrollCalculation, [
						{
							id: calculation,
							set,
							request: input.request,
							domain: policy.domain.id,
							business,
							paidOn,
							release: policy.release,
							purpose: purpose.kind,
							sourceStamp: json(snapshot.stateStamp),
							recordingDay,
							contextHash: fingerprint(context),
							evidence: input.evidence
						}
					])
					yield* draft.insert(
						S.CalculationPolicy,
						policy.approvals.map((row) => ({
							calculation,
							annual: row.annual,
							release: policy.release,
							business,
							authority: row.authority,
							day: paidOn
						}))
					)
					if (purpose.kind === "NewWage") {
						const recoveries = yield* captureRecoveryClaims(snapshot, employee, payDay, input.evidence)
						yield* draft.insert(
							S.CalculationRecoveryClaim,
							recoveries.map((row) => ({ ...row, calculation, set }))
						)
						const depositor = required(
							(yield* relationRows(snapshot, S.MonthlyDepositor)).find(
								(row) => row.business === business && contains(row.valid, payDay)
							),
							"DepositRegimeUnsupported",
							"Record the employer's applicable monthly-depositor classification"
						)
						const span = purpose.work
						if (span.start < policy.calendar.span.start || span.end > policy.calendar.span.end)
							return yield* Effect.fail(
								new Refusal({
									code: "WorkYearBoundary",
									message: "Split a regular work interval at the pay-year boundary"
								})
							)
						yield* draft.insert(S.ProposedWage, [
							{
								calculation,
								business,
								paidOn,
								depositor: depositor.id,
								span,
								roth: purpose.rothCents,
								evidence: input.evidence
							}
						])
					} else {
						const wage = required(target, "WageMissing", "Select an existing wage"),
							previous = required(predecessor, "RevisionNotCurrent", "Select the current predecessor")
						yield* draft.insert(S.ProposedRevision, [
							{
								calculation,
								set,
								business,
								wage: wage.id,
								predecessor: previous.id,
								employee,
								paidOn,
								gross,
								evidence: input.evidence
							}
						])
					}
					const captured = new Map<string, Uuid>()
					for (const component of components) {
						const definition = componentPolicy[component]
						yield* draft.insert(S.Assessment, [
							{ set, component, origin: "Calculated", method: definition.method }
						])
						if (definition.method === "SuppliedAmount") {
							yield* draft.insert(S.ObservedAssessment, [
								{ set, component, amount: input.fit.cents, evidence: input.fit.evidence }
							])
							continue
						}
						const rule = required(
							availableRules.find((row) => row.component === component),
							"RateCoverageMissing",
							`No applicable ${component} rate in the selected release`
						)
						const support = required(
							availableSupports.find((row) => row.program === definition.program),
							"ProgramUnsupported",
							`No supported range for ${definition.program}`
						)
						if (earning.start < support.eligible.start || earning.end > support.eligible.end)
							return yield* Effect.fail(
								new Refusal({
									code: "WageRangeUnsupported",
									message: `${definition.program} earning range exceeds this policy's supported treatment`
								})
							)
						let scope = captured.get(definition.program)
						if (!scope) {
							const existing = availableScopes.find((row) => row.program === definition.program)
							scope = existing?.id ?? (yield* mintId)
							if (!existing) {
								yield* draft.insert(S.TaxBaseScope, [
									{
										id: scope,
										business,
										employee,
										program: definition.program,
										year: BigInt(year),
										calendar: policy.calendar.id,
										span: policy.calendar.span
									}
								])
								if (definition.program === "StateUnemployment")
									yield* draft.insert(S.StateBaseScope, [{ scope, state: "TX" }])
							}
							yield* draft.insert(S.CalculationWageBase, [
								{ set, scope, cents: gross, earning, context: json(context) }
							])
							captured.set(definition.program, scope)
						}
						const basis = yield* mintId
						yield* draft.insert(S.CalculatedAssessment, [{ set, component, basis }])
						yield* draft.insert(S.AppliedRule, [
							{
								set,
								component,
								version: rule.id,
								schedule: rule.schedule,
								release: policy.release,
								business,
								day: paidOn
							}
						])
						yield* draft.insert(S.CalculationBasis, [
							{
								id: basis,
								set,
								component,
								scope,
								domain: policy.domain.id,
								support: support.id,
								business,
								employee,
								year: BigInt(year),
								paidOn,
								schedule: rule.schedule,
								earning,
								cents: gross
							}
						])
					}
					return { calculation, set, purpose: purpose.kind }
				})
		})
	})

export const inspectCalculation = (snapshot: Snapshot, business: Uuid, calculation: Uuid) =>
	Effect.gen(function* () {
		const saved = required(
			(yield* relationRows(snapshot, S.PayrollCalculation)).find(
				(row) => row.id === calculation && row.business === business
			),
			"CalculationMissing",
			"No calculation for this business"
		)
		const input = required(
			(yield* relationRows(snapshot, S.AssessmentSet)).find((row) => row.id === saved.set),
			"AssessmentSetMissing",
			"The calculation input is missing"
		)
		const projection = assessmentForSet(saved.set)
		const amounts = yield* rows(snapshot, projection.assessmentAmounts, {})
		if (amounts.length !== components.length)
			return yield* Effect.fail(
				new Refusal({
					code: "CalculationUnpriced",
					message: "The native calculation did not price every required component"
				})
			)
		const taxableWages = yield* rows(snapshot, projection.calculatedTaxableWages, {})
		const proposal = (yield* relationRows(snapshot, S.ProposedWage)).find(
			(row) => row.calculation === saved.id
		)
		const claims = (yield* relationRows(snapshot, S.CalculationRecoveryClaim)).filter(
			(row) => row.calculation === saved.id
		)
		// Native set order is unspecified. Reestablish the debt allocation order.
		const wages = yield* relationRows(snapshot, S.Wage)
		const wageDays = new Map(wages.map((row) => [row.id, row.paidOn.start]))
		claims.sort((a, b) => {
			const left = required(wageDays.get(a.owedOnWage), "RecoveryScope", "Missing original wage")
			const right = required(wageDays.get(b.owedOnWage), "RecoveryScope", "Missing original wage")
			return left < right
				? -1
				: left > right
					? 1
					: a.owedOnWage.localeCompare(b.owedOnWage) || a.component.localeCompare(b.component)
		})
		const paycheck = proposal
			? settlePaycheck(
					input.gross,
					amounts
						.filter((row) => componentPolicy[row.component].payer === "Employee")
						.reduce((n, row) => n + row.amount, 0n),
					proposal.roth,
					claims.map(({ calculation: _calculation, set: _set, ...row }) => row)
				)
			: undefined
		return { calculation: saved, input, amounts, taxableWages, paycheck }
	})

/** Uses the calculate command's COMMITTED stamp, never its pre-insert source
 * stamp. This also prevents a calculation from being posted a second time.
 */
const freshCalculation = (
	snapshot: Snapshot,
	business: Uuid,
	id: Uuid,
	purpose: Fact<typeof S.PayrollCalculation>["purpose"],
	recordingDay: UnixEpochDay
) =>
	Effect.gen(function* () {
		const inspected = yield* inspectCalculation(snapshot, business, id),
			saved = inspected.calculation
		if (saved.purpose !== purpose)
			return yield* Effect.fail(
				new Refusal({ code: "CalculationPurpose", message: `This command requires ${purpose}` })
			)
		const resolved = yield* resolveRequest(saved.request)
		if (
			resolved.kind !== "found" ||
			resolved.receipt.outcome.kind !== "committed" ||
			resolved.receipt.outcome.result.calculation !== id
		)
			return yield* Effect.fail(
				new Refusal({
					code: "CalculationReceiptMissing",
					message: "Resolve the calculation's original request before posting"
				})
			)
		const stamp = resolved.receipt.stateAt
		if (
			stamp.incarnation !== snapshot.stateStamp.incarnation ||
			stamp.dataRevision !== snapshot.stateStamp.dataRevision ||
			saved.recordingDay !== recordingDay
		)
			return yield* Effect.fail(
				new Refusal({
					code: "CalculationStale",
					message: "The ledger or employer recording day changed; calculate a fresh intent"
				})
			)
		if ((yield* relationRows(snapshot, S.AssessmentRevision)).some((row) => row.set === saved.set))
			return yield* Effect.fail(
				new Refusal({
					code: "CalculationAlreadyPosted",
					message: "This calculation already has a posted revision"
				})
			)
		return inspected
	})

const revisionFacts = (snapshot: Snapshot, draft: Draft, revision: Fact<typeof S.AssessmentRevision>) =>
	Effect.gen(function* () {
		const taxAccounts = (yield* relationRows(snapshot, S.TaxAccount)).filter(
			(row) => row.business === revision.business
		)
		yield* draft.insert(S.AssessmentRevision, [revision])
		const links: Fact<typeof S.RevisionAccount>[] = []
		for (const family of S.AccountFamily.handles) {
			const account = required(
				taxAccounts.find((row) => row.family === family),
				"TaxAccountMissing",
				`Configure ${family} before posting`
			)
			links.push({ revision: revision.id, account: account.id, business: revision.business, family })
		}
		yield* draft.insert(S.RevisionAccount, links)
		return links
	})

/** The sole normal wage-posting boundary. Recovery resolves its own request
 * first; new posting always inspects the shared work register at a fresh clock.
 */
export const postPayroll = (payload: unknown) =>
	Effect.gen(function* () {
		const input = parseStrict(PostInput, payload),
			business = input.business
		return yield* businessCommand({
			request: input.request,
			business,
			action: "payroll post",
			input: payload,
			plan: ({ snapshot, draft, recordingDay, recordedAt }) =>
				Effect.gen(function* () {
					const inspected = yield* freshCalculation(
						snapshot,
						business,
						input.calculation,
						"NewWage",
						recordingDay
					)
					const { calculation, amounts } = inspected,
						set = inspected.input,
						payDay = epochDay(set.paidOn.start),
						year = toCalendarDate(payDay).year
					yield* requirePayrollReady(snapshot, business, payDay > recordingDay ? payDay : recordingDay)
					const proposal = required(
						(yield* relationRows(snapshot, S.ProposedWage)).find((row) => row.calculation === calculation.id),
						"ProposalMissing",
						"The new-wage proposal is missing"
					)
					const policy = yield* policyAt(snapshot, business, payDay)
					const budget = required(
						(yield* relationRows(snapshot, S.AnnualBudget)).find(
							(row) => row.employee === set.employee && row.year === BigInt(year)
						),
						"BudgetMissing",
						"Record the evidenced annual budget before posting"
					)
					// Reaching the trigger changes the regime for that year AND the next.
					// Inspect original accruals across both years; settlement and revisions
					// cannot make a previously triggered month disappear.
					const recordingYear = toCalendarDate(recordingDay).year
					const relevantYears = new Set([year - 1, year, recordingYear - 1, recordingYear])
					const monthly = new Map<string, bigint>()
					for (const row of yield* rows(snapshot, initialFederalAccruals, {})) {
						const date = toCalendarDate(epochDay(row.paidOn.start))
						if (row.business !== business || !relevantYears.has(date.year)) continue
						const key = `${date.year}/${date.month}`
						monthly.set(key, unsigned((monthly.get(key) ?? 0n) + row.amount))
					}
					const monthKey = `${year}/${toCalendarDate(payDay).month}`
					const proposed = amounts
						.filter((row) => componentPolicy[row.component].family === "Federal941")
						.reduce((sum, row) => unsigned(sum + row.amount), 0n)
					monthly.set(monthKey, unsigned((monthly.get(monthKey) ?? 0n) + proposed))
					if ([...monthly.values()].some((amount) => amount >= policy.domain.federalDepositLimit))
						return yield* Effect.fail(
							new Refusal({
								code: "DepositRegimeUnsupported",
								message:
									"A federal monthly accumulation reached the next-day trigger in the relevant current/prior year; the monthly-only payroll regime cannot admit this wage"
							})
						)
					if (proposal.roth > 0n) {
						const plan = required(
							(yield* relationRows(snapshot, S.RetirementPlan)).find((r) => r.employee === set.employee),
							"RetirementPlanMissing",
							"Configure the owner retirement plan before new Roth payroll"
						)
						yield* admitContribution(
							snapshot,
							plan.id,
							"EmployeeRothDeferral",
							proposal.roth,
							payDay,
							set.gross
						)
					}
					const election =
						proposal.roth > 0n
							? required(
									(yield* relationRows(snapshot, S.Election)).find(
										(row) =>
											row.employee === set.employee &&
											row.year === BigInt(year) &&
											row.signedOn <= payDay &&
											contains(row.effective, payDay)
									),
									"ElectionMissing",
									"Record the applicable signed election and employee allowance before new Roth payroll"
								)
							: undefined
					const commitment = yield* mintId,
						wage = yield* mintId,
						revision = yield* mintId
					yield* draft.insert(S.BudgetCommitment, [
						{
							id: commitment,
							employee: set.employee,
							year: BigInt(year),
							amount: set.gross,
							origin: "Regular",
							evidence: proposal.evidence
						}
					])
					yield* draft.insert(S.BudgetAssignment, [
						{ commitment, budget: budget.id, employee: set.employee, year: BigInt(year), amount: set.gross }
					])
					yield* draft.insert(S.Wage, [
						{
							id: wage,
							requiresTransfer: input.settlement.kind === "Bank",
							business,
							employee: set.employee,
							year: BigInt(year),
							calendar: policy.calendar.id,
							paidOn: set.paidOn,
							commitment,
							gross: set.gross,
							initialRevision: revision,
							recordedAt
						}
					])
					yield* draft.insert(S.RegularCommitment, [{ commitment, wage }])
					yield* draft.insert(S.RegularWork, [{ wage, employee: set.employee, span: proposal.span }])
					const deductions = withholdingPolicy.map(({ component, kind }) => ({
						wage,
						employee: set.employee,
						year: BigInt(year),
						kind,
						amount: required(
							amounts.find((row) => row.component === component),
							"AssessmentMissing",
							`Missing ${component}`
						).amount,
						evidence: calculation.evidence
					}))
					yield* draft.insert(S.Deduction, deductions)
					const paycheck = required(
						inspected.paycheck,
						"ProposalMissing",
						"New payroll requires a calculated paycheck"
					)
					const recovery = yield* recoveryFacts(draft, wage, paycheck.recoveries)
					if (recovery > 0n)
						yield* draft.insert(S.Deduction, [
							{
								wage,
								employee: set.employee,
								year: BigInt(year),
								kind: "Recovery",
								amount: recovery,
								evidence: calculation.evidence
							}
						])
					if (election) {
						yield* draft.insert(S.Deduction, [
							{
								wage,
								employee: set.employee,
								year: BigInt(year),
								kind: "Roth",
								amount: proposal.roth,
								evidence: election.evidence
							}
						])
						yield* draft.insert(S.ElectionUse, [
							{
								wage,
								election: election.id,
								employee: set.employee,
								day: set.paidOn,
								kind: "Roth",
								amount: proposal.roth
							}
						])
					}

					const { cash } = paycheck
					const settlement = input.settlement
					let allocation: Uuid | undefined
					if (settlement.kind === "NoTransfer") {
						if (cash !== 0n || proposal.roth !== 0n)
							return yield* Effect.fail(
								new Refusal({
									code: "PayrollTransferRequired",
									message: "No-transfer posting requires zero cash and zero Roth remittance"
								})
							)
					} else {
						const bankDay = settlement.paidOn,
							bankAmount = settlement.amount
						if (bankDay > recordingDay)
							return yield* Effect.fail(
								new Refusal({ code: "FuturePayment", message: "Post after the Mercury payment is sent" })
							)
						if (bankAmount <= 0n || bankAmount !== (cash > 0n ? cash : proposal.roth))
							return yield* Effect.fail(
								new Refusal({
									code: "PayrollBankAmount",
									message:
										"The positive Mercury amount must match calculated cash, or the Roth remittance when cash is zero"
								})
							)
						const movement = yield* mintId
						allocation = yield* mintId
						yield* draft.insert(S.BankMovement, [
							{
								id: movement,
								business,
								direction: "Outflow",
								paidOn: bankDay,
								amount: bankAmount,
								evidence: calculation.evidence,
								recordedAt
							}
						])
						yield* draft.insert(S.MercuryTransaction, [{ movement, reference: settlement.reference }])
						yield* draft.insert(S.PayrollTransaction, [{ wage, movement, business }])
						yield* draft.insert(S.CashAllocation, [
							{
								id: allocation,
								movement,
								business,
								purpose: cash > 0n ? "PayrollCash" : "RothRemittance",
								amount: bankAmount,
								evidence: calculation.evidence
							}
						])
						if (cash > 0n) yield* draft.insert(S.PayrollCashBinding, [{ allocation, wage, business }])
					}
					if (proposal.roth > 0n) {
						const plan = required(
							(yield* relationRows(snapshot, S.RetirementPlan)).find((r) => r.employee === set.employee),
							"RetirementPlanMissing",
							"Configure the owner retirement plan"
						)
						const contribution = yield* mintId
						yield* draft.insert(S.RetirementContribution, [
							{
								business,
								id: contribution,
								plan: plan.id,
								employee: set.employee,
								year: BigInt(year),
								amount: proposal.roth,
								source: "EmployeeRothDeferral",
								origin: "Observed",
								evidence: calculation.evidence,
								recordedAt
							}
						])
						yield* draft.insert(S.ContributionDeduction, [
							{
								kind: "Roth",
								contribution,
								wage,
								employee: set.employee,
								year: BigInt(year),
								amount: proposal.roth
							}
						])
						if (cash === 0n)
							yield* draft.insert(S.ContributionFunding, [
								{
									contribution,
									allocation: required(
										allocation,
										"PayrollTransferRequired",
										"Roth requires an actual remittance"
									),
									business,
									source: "EmployeeRothDeferral",
									amount: proposal.roth
								}
							])
					}
					yield* revisionFacts(snapshot, draft, {
						id: revision,
						wage,
						set: set.id,
						business,
						employee: set.employee,
						paidOn: set.paidOn,
						gross: set.gross,
						kind: "Initial",
						recordedAt
					})
					yield* ensureFilingFacts(snapshot, draft, {
						business,
						throughYear: year,
						additionalPaidEmployees: [{ employee: set.employee, year }]
					})
					return { wage, revision, calculation: calculation.id, commitment }
				})
		})
	})

export const revisePayrollTax = (payload: unknown) =>
	Effect.gen(function* () {
		const input = parseStrict(ReviseInput, payload),
			business = input.business
		return yield* businessCommand({
			request: input.request,
			business,
			action: "payroll revise-tax",
			input: payload,
			plan: ({ snapshot, draft, recordingDay, recordedAt }) =>
				Effect.gen(function* () {
					const prepared = yield* Effect.gen(function* () {
						const source = input.assessment
						if (source.kind === "Calculated") {
							const { calculation, input: set } = yield* freshCalculation(
								snapshot,
								business,
								entityId(source.calculation),
								"TaxRevision",
								recordingDay
							)
							const proposal = required(
								(yield* relationRows(snapshot, S.ProposedRevision)).find(
									(row) => row.calculation === calculation.id
								),
								"ProposalMissing",
								"The tax revision proposal is missing"
							)
							return { set, proposal, calculation: calculation.id }
						}
						const wage = required(
							(yield* relationRows(snapshot, S.Wage)).find(
								(row) => row.id === source.wage && row.business === business
							),
							"WageMissing",
							"External reassessment requires an existing paid wage"
						)
						const set = yield* observedSetFacts(
							draft,
							{
								id: yield* mintId,
								business,
								employee: wage.employee,
								paidOn: wage.paidOn,
								gross: wage.gross,
								origin: "Observed"
							},
							source.figures
						)
						return {
							set,
							proposal: {
								wage: wage.id,
								predecessor: entityId(source.predecessor),
								evidence: source.figures.evidence
							}
						}
					})
					const { set, proposal } = prepared
					required(
						(yield* rows(snapshot, currentRevisions, {})).find(
							(row) => row.id === proposal.predecessor && row.wage === proposal.wage
						),
						"RevisionNotCurrent",
						"The revision predecessor changed"
					)
					const revision = yield* mintId
					const revisionFact: Fact<typeof S.AssessmentRevision> = {
						id: revision,
						wage: proposal.wage,
						set: set.id,
						business,
						employee: set.employee,
						paidOn: set.paidOn,
						gross: set.gross,
						kind: "Correction",
						recordedAt
					}
					const links = yield* revisionFacts(snapshot, draft, revisionFact)
					yield* draft.insert(S.CorrectionAssessment, [
						{ revision, predecessor: proposal.predecessor, wage: proposal.wage, evidence: proposal.evidence }
					])
					const amendments = yield* revisionFilingFacts(snapshot, draft, {
						revision: revisionFact,
						accounts: links,
						recordingDay,
						evidence: proposal.evidence,
						deadlines: input.amendments ?? []
					})
					return {
						wage: proposal.wage,
						revision,
						predecessor: proposal.predecessor,
						...("calculation" in prepared ? { calculation: prepared.calculation } : {}),
						amendmentsJson: json(amendments)
					}
				})
		})
	})

/** Relevant readback for successful calculate/post commands. The native
 * receipt remains authoritative even if pricing raises an overflow refusal.
 */
export const payrollReadback = (receipt: Awaited<Effect.Success<ReturnType<typeof calculatePayroll>>>) =>
	Effect.gen(function* () {
		if (receipt.outcome.kind !== "committed" && receipt.outcome.kind !== "no-change") return { receipt }
		const result = receipt.outcome.result,
			snapshot = yield* latest
		const calculation =
			typeof result.calculation === "string"
				? (yield* relationRows(snapshot, S.PayrollCalculation)).find((row) => row.id === result.calculation)
				: undefined
		const figures = calculation
			? yield* inspectCalculation(snapshot, calculation.business, calculation.id)
			: undefined
		const cash =
			typeof result.wage === "string"
				? (yield* rows(snapshot, netCash, {})).find((row) => row.wage === result.wage)
				: undefined
		return { receipt, figures, cash }
	})
