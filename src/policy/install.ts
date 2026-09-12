import type { IntervalValue, Uuid } from "@bjornpagen/bumbledb"
import { Effect, Schema } from "effect"
import { businessCommand } from "../commands.ts"
import { epochDay } from "../core/time.ts"
import { MAX_U64, mintId, Nonblank, Refusal } from "../core/values.ts"
import { relationRows } from "../queries.ts"
import { fingerprint, parseStrict, type Snapshot } from "../runtime.ts"
import { CentRange, commandFields, DaySpan, inputFields, TaxBandInput, Year } from "../schema/input.ts"
import { componentPolicy, components, formPolicy, forms, submissionSlots } from "../schema/vocabulary.ts"
import * as S from "../schema.ts"
import { annualPolicyData } from "./annual.ts"
import { CalendarInput, installCalendarFacts, nominalDeadline } from "./calendar.ts"

const RuleInput = Schema.Struct({
	...inputFields(S.RateVersion, ["component", "valid", "evidence"], { valid: DaySpan }),
	...inputFields(S.RateSchedule, ["denominator"]),
	bands: Schema.Array(TaxBandInput),
	employerNotice: Schema.optional(Nonblank),
	futaBasis: Schema.optional(Nonblank)
})
const DepositInput = Schema.Struct({
	...inputFields(S.DepositPolicy, ["family", "valid", "periodKind", "authority", "dueRule", "evidence"], {
		valid: DaySpan
	}),
	triggers: Schema.Record(Schema.Literals(S.CheckpointKind.handles), CentRange)
})
export const PolicyInput = Schema.Struct({
	...commandFields,
	...inputFields(S.PolicyRelease, ["title", "evidence"]),
	calendars: Schema.Array(CalendarInput),
	filingRules: Schema.Array(Schema.Struct(inputFields(S.FilingRule, ["form", "dueRule", "evidence"]))),
	deposits: Schema.Array(DepositInput),
	payroll: Schema.optional(
		Schema.Struct({
			...inputFields(S.SupportedPayrollDomain, ["valid", "federalDepositLimit", "evidence"], {
				valid: DaySpan
			}),
			programs: Schema.Array(
				Schema.Struct(
					inputFields(S.SupportedProgram, ["program", "eligible", "evidence"], { eligible: CentRange })
				)
			),
			rates: Schema.Array(RuleInput),
			deferrals: Schema.Array(
				Schema.Struct(inputFields(S.DeferralPolicy, ["year", "limit", "evidence"], { year: Year }))
			),
			grossSuggestion: Schema.Struct(inputFields(S.GrossSuggestionPolicy, ["method", "evidence"])),
			monthlyDepositor: Schema.Struct(
				inputFields(S.MonthlyDepositor, ["valid", "evidence"], { valid: DaySpan })
			)
		})
	)
})
export const ActivateInput = Schema.Struct({
	...commandFields,
	...inputFields(S.PolicyBinding, ["release", "evidence"])
})

/** Installs an immutable, hashed release. This is an explicit evidence boundary:
 * rates, thresholds, holiday rules and employer notices are supplied together.
 * No built-in year/rate fallback or TypeScript tax evaluator participates.
 */
export const installPolicy = (payload: unknown) =>
	Effect.gen(function* () {
		const input = parseStrict(PolicyInput, payload),
			business = input.business
		return yield* businessCommand({
			request: input.request,
			business,
			action: "policy install",
			input: payload,
			plan: ({ snapshot, draft, recordedAt }) =>
				Effect.gen(function* () {
					const { request: _, ...content } = input,
						sha256 = fingerprint(content)
					const existing = (yield* relationRows(snapshot, S.PolicyRelease)).find(
						(row) => row.sha256 === sha256
					)
					if (existing) return { release: existing.id, sha256 }
					const release = yield* mintId
					yield* draft.insert(S.PolicyRelease, [
						{ id: release, sha256, title: input.title, evidence: input.evidence, recordedAt }
					])
					const calendars = []
					for (const calendar of input.calendars)
						calendars.push(yield* installCalendarFacts(draft, release, calendar))
					for (const rule of input.filingRules)
						yield* draft.insert(S.FilingRule, [
							{
								id: yield* mintId,
								release,
								form: rule.form,
								authority: formPolicy[rule.form].authority,
								periodKind: formPolicy[rule.form].period,
								dueRule: rule.dueRule,
								evidence: rule.evidence
							}
						])
					for (const rule of submissionSlots) {
						const policy = yield* mintId
						yield* draft.insert(S.FormMethodPolicy, [
							{
								id: policy,
								release,
								form: rule.form,
								method: rule.method,
								requiredCount: BigInt(rule.slots.length)
							}
						])
						for (const slot of rule.slots)
							yield* draft.insert(S.DocumentRequirement, [{ policy, slot, role: slot }])
					}
					const taxAccounts = (yield* relationRows(snapshot, S.TaxAccount)).filter(
						(row) => row.business === business
					)
					for (const definition of input.deposits) {
						const account = taxAccounts.find((row) => row.family === definition.family)
						if (!account)
							return yield* Effect.fail(
								new Refusal({
									code: "TaxAccountMissing",
									message: `Configure ${definition.family} before policy installation`
								})
							)
						const policy = yield* mintId,
							valid = definition.valid
						const calendar = calendars.find(
							(row) =>
								row.authority === definition.authority &&
								row.span.start <= valid.start &&
								row.span.end >= valid.end
						)
						if (!calendar)
							return yield* Effect.fail(
								new Refusal({
									code: "CalendarCoverageMissing",
									message: "The deposit policy requires a complete calendar for its authority and validity"
								})
							)
						yield* draft.insert(S.DepositPolicy, [
							{
								id: policy,
								release,
								business,
								account: account.id,
								family: definition.family,
								periodKind: definition.periodKind,
								valid,
								authority: definition.authority,
								dueRule: definition.dueRule,
								evidence: definition.evidence
							}
						])
						for (const kind of S.CheckpointKind.handles)
							yield* draft.insert(S.DepositTrigger, [{ policy, kind, actionable: definition.triggers[kind] }])
						const periods = calendar.periods.filter(
							(row) =>
								row.kind === definition.periodKind &&
								row.span.start >= valid.start &&
								row.span.end <= valid.end
						)
						for (const period of periods) {
							const nominal = nominalDeadline(definition.dueRule, epochDay(period.span.end))
							// These calendar facts have not committed yet. Select from the same pure
							// Gregorian expansion that supplies the native day/coverage facts; regular
							// reads use followingBusinessDay against the published snapshot.
							const due = calendar.days.find((row) => row.eligible && row.span.start >= nominal)
							if (!due)
								return yield* Effect.fail(
									new Refusal({
										code: "CalendarCoverageMissing",
										message: "Extend the business calendar through each rolled deposit deadline"
									})
								)
							const terminal = calendar.periods.some(
								(row) => row.kind === "Year" && row.year === period.year && row.span.end === period.span.end
							)
							yield* draft.insert(S.DepositCheckpoint, [
								{
									id: yield* mintId,
									policy,
									business,
									account: account.id,
									calendar: period.id,
									periodKind: definition.periodKind,
									span: period.span,
									year: period.year,
									kind: terminal ? "Terminal" : "Interim",
									opensOn: period.span.end,
									dueOn: due.span.start,
									evidence: definition.evidence
								}
							])
						}
					}
					if (input.payroll) {
						const payroll = input.payroll,
							domain = yield* mintId,
							valid = payroll.valid
						yield* draft.insert(S.SupportedPayrollDomain, [
							{
								id: domain,
								release,
								state: "TX",
								federalDepositLimit: payroll.federalDepositLimit,
								valid,
								evidence: payroll.evidence
							}
						])
						for (const support of payroll.programs)
							yield* draft.insert(S.SupportedProgram, [
								{
									id: yield* mintId,
									domain,
									program: support.program,
									eligible: support.eligible,
									evidence: support.evidence
								}
							])
						const covered = new Set<(typeof S.Component.handles)[number]>()
						for (const rate of payroll.rates) {
							if (!covered.has(rate.component)) {
								yield* draft.insert(S.PolicyCoverage, [
									{ release, business, component: rate.component, span: valid }
								])
								covered.add(rate.component)
							}
							const schedule = yield* mintId,
								version = yield* mintId,
								rateValid = rate.valid
							yield* draft.insert(S.RateSchedule, [
								{
									id: schedule,
									denominator: rate.denominator,
									domain: { start: 0n, end: MAX_U64 },
									evidence: rate.evidence
								}
							])
							for (const band of rate.bands)
								yield* draft.insert(S.TaxBand, [
									{
										id: yield* mintId,
										schedule,
										span: { start: band.start, end: band.end },
										numerator: band.numerator,
										role: band.role
									}
								])
							yield* draft.insert(S.RateVersion, [
								{
									id: version,
									release,
									business,
									component: rate.component,
									valid: rateValid,
									schedule,
									evidence: rate.evidence
								}
							])
							if (rate.employerNotice) {
								const notice = yield* mintId
								yield* draft.insert(S.EmployerRateNotice, [
									{
										id: notice,
										business,
										state: "TX",
										schedule,
										valid: rateValid,
										evidence: rate.employerNotice
									}
								])
								yield* draft.insert(S.EmployerSchedule, [
									{ version, notice, business, schedule, valid: rateValid }
								])
							}
							if (rate.futaBasis) yield* draft.insert(S.FutaBasis, [{ version, evidence: rate.futaBasis }])
						}
						for (const rule of payroll.deferrals)
							yield* draft.insert(S.DeferralPolicy, [
								{
									id: yield* mintId,
									release,
									year: rule.year,
									limit: rule.limit,
									evidence: rule.evidence
								}
							])
						yield* draft.insert(S.GrossSuggestionPolicy, [
							{ id: yield* mintId, release, ...payroll.grossSuggestion }
						])
						const classification = payroll.monthlyDepositor,
							classified = classification.valid
						const old = (yield* relationRows(snapshot, S.MonthlyDepositor)).find(
							(row) =>
								row.business === business &&
								row.valid.start <= classified.start &&
								row.valid.end >= classified.end
						)
						if (!old)
							yield* draft.insert(S.MonthlyDepositor, [
								{ id: yield* mintId, business, valid: classified, evidence: classification.evidence }
							])
					}
					return { release, sha256 }
				})
		})
	})

/** Exact union coverage at the policy admission boundary. Native rate and
 * checkpoint partitions independently enforce each declared interval. */
const covers = (target: IntervalValue, spans: readonly IntervalValue[]) => {
	let end = target.start
	for (const span of [...spans].sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0))) {
		if (span.start > end) break
		if (span.end > end) end = span.end
	}
	return end >= target.end
}

export const activatePolicy = (payload: unknown) =>
	Effect.gen(function* () {
		const input = parseStrict(ActivateInput, payload),
			business = input.business,
			release = input.release
		return yield* businessCommand({
			request: input.request,
			business,
			action: "policy activate",
			input: payload,
			plan: ({ snapshot, draft }) =>
				Effect.gen(function* () {
					if (!(yield* relationRows(snapshot, S.PolicyRelease)).some((row) => row.id === release))
						return yield* Effect.fail(
							new Refusal({ code: "PolicyMissing", message: "Install the checked policy release first" })
						)
					const own = (yield* relationRows(snapshot, S.DepositPolicy)).filter(
						(row) => row.release === release && row.business === business
					)
					if (!S.AccountFamily.handles.every((family) => own.some((row) => row.family === family)))
						return yield* Effect.fail(
							new Refusal({
								code: "PolicyScopeMissing",
								message: "The release must include this business's complete deposit-account policy"
							})
						)
					const filingRules = (yield* relationRows(snapshot, S.FilingRule)).filter(
						(row) => row.release === release
					)
					const missingForms = forms.filter(
						(form) =>
							formPolicy[form].due !== "RecordedEvent" && !filingRules.some((rule) => rule.form === form)
					)
					if (missingForms.length)
						return yield* Effect.fail(
							new Refusal({
								code: "FilingPolicyIncomplete",
								message: `Missing recurring form rules: ${missingForms.join(", ")}`
							})
						)
					// Activation may replace the current policy, but must retain
					// a checkpoint for every already posted liability's pay date.
					const posted = (yield* relationRows(snapshot, S.RevisionAccount)).filter(
						(row) => row.business === business
					)
					const revisions = yield* relationRows(snapshot, S.AssessmentRevision)
					for (const entry of posted) {
						const revision = revisions.find((row) => row.id === entry.revision)
						if (
							!revision ||
							!own.some(
								(policy) =>
									policy.account === entry.account &&
									policy.valid.start <= revision.paidOn.start &&
									policy.valid.end >= revision.paidOn.end
							)
						)
							return yield* Effect.fail(
								new Refusal({
									code: "HistoricalDepositCoverageMissing",
									message: "The replacement release must cover all posted liability dates"
								})
							)
					}
					const coverage = (yield* relationRows(snapshot, S.PolicyCoverage)).filter(
						(row) => row.release === release && row.business === business
					)
					const payrollDomains = (yield* relationRows(snapshot, S.SupportedPayrollDomain)).filter(
						(row) => row.release === release
					)
					for (const domain of payrollDomains) {
						const missing = components.filter(
							(component) =>
								componentPolicy[component].method === "MarginalBands" &&
								!covers(
									domain.valid,
									coverage.filter((row) => row.component === component).map((row) => row.span)
								)
						)
						if (missing.length)
							return yield* Effect.fail(
								new Refusal({
									code: "PayrollPolicyIncomplete",
									message: `Missing complete rate coverage: ${missing.join(", ")}`
								})
							)
						if (
							!S.AccountFamily.handles.every((family) =>
								covers(
									domain.valid,
									own.filter((row) => row.family === family).map((row) => row.valid)
								)
							)
						)
							return yield* Effect.fail(
								new Refusal({
									code: "DepositCoverageMissing",
									message: "Deposit policies must cover the full supported payroll interval"
								})
							)
					}
					const old = (yield* relationRows(snapshot, S.PolicyBinding)).find(
						(row) => row.business === business
					)
					if (old) yield* draft.delete(S.PolicyBinding, [old])
					yield* draft.insert(S.PolicyBinding, [{ business, release, evidence: input.evidence }])
					return { business, release }
				})
		})
	})

export const inspectPolicy = (snapshot: Snapshot, business: Uuid) =>
	Effect.gen(function* () {
		const binding = (yield* relationRows(snapshot, S.PolicyBinding)).find((row) => row.business === business)
		return {
			binding,
			annual: yield* annualPolicyData(snapshot, business),
			releases: yield* relationRows(snapshot, S.PolicyRelease),
			domains: yield* relationRows(snapshot, S.SupportedPayrollDomain),
			rates: (yield* relationRows(snapshot, S.RateVersion)).filter((row) => row.business === business),
			deposits: (yield* relationRows(snapshot, S.DepositPolicy)).filter((row) => row.business === business),
			monthlyDepositor: (yield* relationRows(snapshot, S.MonthlyDepositor)).filter(
				(row) => row.business === business
			)
		}
	})
