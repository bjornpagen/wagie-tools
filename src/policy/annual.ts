import type { IntervalValue, Uuid } from "@bjornpagen/bumbledb"
import { Effect, Schema } from "effect"
import { businessCommand } from "../commands.ts"
import { civilDaySpan, epochDay, periodSpan, type UnixEpochDay } from "../core/time.ts"
import { MAX_U64, mintId, Refusal } from "../core/values.ts"
import { relationRows } from "../queries.ts"
import { parseStrict, type Snapshot } from "../runtime.ts"
import {
	commandFields,
	Day,
	DayBounds,
	Id,
	inputField,
	inputFields,
	TaxBandInput,
	Year
} from "../schema/input.ts"
import { annualRequirements } from "../schema/vocabulary.ts"
import * as S from "../schema.ts"

const Source = Schema.Struct(inputFields(S.AnnualSource, ["artifact", "evidence"]))
export const AnnualPolicyInput = Schema.Struct({
	...commandFields,
	...inputFields(S.AnnualPolicy, ["authority", "year", "evidence"], { year: Year }),
	release: Id,
	sources: Schema.Array(Source),
	rates: Schema.Array(
		Schema.Struct({
			...inputFields(S.PublishedRate, ["kind"]),
			...inputFields(S.RateSchedule, ["denominator"]),
			bands: Schema.Array(TaxBandInput),
			...Source.fields
		})
	),
	limits: Schema.Array(Schema.Struct({ ...inputFields(S.PolicyLimit, ["kind", "cents"]), ...Source.fields })),
	lookback: Schema.optional(Schema.Struct({ ...DayBounds.fields, ...Source.fields }))
})
export const AnnualEvidenceInput = Schema.Struct({
	...commandFields,
	...inputFields(S.AnnualEvidence, ["annual", "kind", "artifact", "evidence"])
})
export const RefreshInput = Schema.Struct({
	...commandFields,
	...inputFields(S.AnnualApproval, ["annual", "release", "evidence"])
})

const fail = (code: string, message: string) => Effect.fail(new Refusal({ code, message }))
const includes = (values: readonly string[], value: string) => values.includes(value)

/** Store published facts even when employer-specific execution evidence is missing.
 * Public sources are verified content identities; recording does not approve payroll.
 */
export const recordAnnualPolicy = (payload: unknown) =>
	Effect.gen(function* () {
		const input = parseStrict(AnnualPolicyInput, payload),
			business = input.business
		return yield* businessCommand({
			request: input.request,
			business,
			action: "policy annual",
			input: payload,
			plan: ({ snapshot, draft, recordedAt }) =>
				Effect.gen(function* () {
					const release = input.release,
						valid = periodSpan(Number(input.year), "Year")
					const calendar = (yield* relationRows(snapshot, S.CalendarPeriod)).find(
						(row) =>
							row.release === release &&
							row.authority === input.authority &&
							row.kind === "Year" &&
							row.year === input.year
					)
					if (!calendar)
						return yield* fail(
							"CalendarCoverageMissing",
							"Install the reviewed calendar for this policy year"
						)
					const required = annualRequirements[input.authority]
					if (
						input.rates.some((row) => !includes(required.rates, row.kind)) ||
						input.limits.some((row) => !includes(required.limits, row.kind)) ||
						(input.lookback && input.authority !== "FederalDC")
					)
						return yield* fail("PolicyAuthorityMismatch", "The rule does not belong to this policy authority")
					const annual = yield* mintId
					yield* draft.insert(S.AnnualPolicy, [
						{
							id: annual,
							business,
							authority: input.authority,
							year: input.year,
							calendar: calendar.id,
							valid,
							evidence: input.evidence,
							recordedAt
						}
					])
					yield* draft.insert(
						S.AnnualSource,
						input.sources.map((row) => ({ annual, artifact: row.artifact, evidence: row.evidence }))
					)
					for (const rate of input.rates) {
						const schedule = yield* mintId
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
									span: {
										start: band.start,
										end: band.end
									},
									numerator: band.numerator,
									role: band.role
								}
							])
						yield* draft.insert(S.PublishedRate, [
							{
								annual,
								kind: rate.kind,
								schedule,
								artifact: rate.artifact,
								evidence: rate.evidence
							}
						])
					}
					yield* draft.insert(
						S.PolicyLimit,
						input.limits.map((row) => ({
							annual,
							kind: row.kind,
							cents: row.cents,
							artifact: row.artifact,
							evidence: row.evidence
						}))
					)
					if (input.lookback)
						yield* draft.insert(S.LookbackPeriod, [
							{
								annual,
								span: civilDaySpan(input.lookback.start, input.lookback.endExclusive),
								artifact: input.lookback.artifact,
								evidence: input.lookback.evidence
							}
						])
					return { annual }
				})
		})
	})

export const recordAnnualEvidence = (payload: unknown) =>
	Effect.gen(function* () {
		const input = parseStrict(AnnualEvidenceInput, payload),
			business = input.business,
			annual = input.annual
		return yield* businessCommand({
			request: input.request,
			business,
			action: "policy evidence",
			input: payload,
			plan: ({ snapshot, draft, recordedAt }) =>
				Effect.gen(function* () {
					const policy = (yield* relationRows(snapshot, S.AnnualPolicy)).find(
						(row) => row.id === annual && row.business === business
					)
					if (!policy) return yield* fail("AnnualPolicyMissing", "Select this business's annual policy")
					if (!includes(annualRequirements[policy.authority].evidence, input.kind))
						return yield* fail("PolicyAuthorityMismatch", "Evidence belongs to a different authority")
					yield* draft.insert(S.AnnualEvidence, [
						{
							annual,
							kind: input.kind,
							artifact: input.artifact,
							evidence: input.evidence,
							recordedAt
						}
					])
					return { annual, kind: input.kind }
				})
		})
	})

export const annualPolicyData = (snapshot: Snapshot, business: Uuid) =>
	Effect.gen(function* () {
		const policies = (yield* relationRows(snapshot, S.AnnualPolicy)).filter(
			(row) => row.business === business
		)
		const own = new Set(policies.map((row) => row.id))
		const rates = (yield* relationRows(snapshot, S.PublishedRate)).filter((row) => own.has(row.annual))
		const schedules = new Set(rates.map((row) => row.schedule))
		return {
			policies,
			rates,
			schedules: (yield* relationRows(snapshot, S.RateSchedule)).filter((row) => schedules.has(row.id)),
			bands: (yield* relationRows(snapshot, S.TaxBand)).filter((row) => schedules.has(row.schedule)),
			limits: (yield* relationRows(snapshot, S.PolicyLimit)).filter((row) => own.has(row.annual)),
			lookbacks: (yield* relationRows(snapshot, S.LookbackPeriod)).filter((row) => own.has(row.annual)),
			sources: (yield* relationRows(snapshot, S.AnnualSource)).filter((row) => own.has(row.annual)),
			evidence: (yield* relationRows(snapshot, S.AnnualEvidence)).filter((row) => own.has(row.annual)),
			approvals: (yield* relationRows(snapshot, S.AnnualApproval)).filter((row) => row.business === business)
		}
	})
export type AnnualData = Effect.Success<ReturnType<typeof annualPolicyData>>
export function missingAnnualInputs(data: AnnualData, annual: Uuid): string[] {
	const policy = data.policies.find((row) => row.id === annual)
	if (!policy) return ["AnnualPolicy"]
	const required = annualRequirements[policy.authority]
	return [
		...required.rates.filter((kind) => !data.rates.some((row) => row.annual === annual && row.kind === kind)),
		...required.limits.filter(
			(kind) => !data.limits.some((row) => row.annual === annual && row.kind === kind)
		),
		...required.evidence.filter(
			(kind) => !data.evidence.some((row) => row.annual === annual && row.kind === kind)
		),
		...(policy.authority === "FederalDC" && !data.lookbacks.some((row) => row.annual === annual)
			? ["LookbackPeriod"]
			: [])
	]
}

/** Each authority is refreshed explicitly for one release and one civil year.
 * An unchanged rate in a later year still requires new sources and approval.
 */
export const refreshPolicy = (payload: unknown) =>
	Effect.gen(function* () {
		const input = parseStrict(RefreshInput, payload),
			business = input.business,
			annual = input.annual,
			release = input.release
		return yield* businessCommand({
			request: input.request,
			business,
			action: "policy refresh",
			input: payload,
			plan: ({ snapshot, draft, recordedAt }) =>
				Effect.gen(function* () {
					const data = yield* annualPolicyData(snapshot, business)
					const policy = data.policies.find((row) => row.id === annual)
					if (!policy)
						return yield* fail("AnnualPolicyMissing", "Record this business's published annual rules first")
					const missing = missingAnnualInputs(data, annual)
					if (missing.length)
						return yield* fail("AnnualPolicyIncomplete", `Missing verified inputs: ${missing.join(", ")}`)
					const covers = (span: IntervalValue) =>
						span.start <= policy.valid.start && span.end >= policy.valid.end
					const domains = (yield* relationRows(snapshot, S.SupportedPayrollDomain)).filter(
						(row) => row.release === release && covers(row.valid)
					)
					if (domains.length !== 1)
						return yield* fail(
							"PayrollPolicyMissing",
							"Install an executable domain covering this policy year"
						)
					const rates = (yield* relationRows(snapshot, S.RateVersion)).filter(
						(row) => row.release === release && row.business === business && covers(row.valid)
					)
					if (policy.authority === "FederalDC") {
						if (
							!(yield* relationRows(snapshot, S.MonthlyDepositor)).some(
								(row) => row.business === business && covers(row.valid)
							)
						)
							return yield* fail(
								"DepositRegimeUnsupported",
								"Record the evidenced annual employer depositor classification"
							)
						const nextDay = data.limits.find(
							(row) => row.annual === annual && row.kind === "NextDayDepositMinimum"
						)
						if (domains[0]?.federalDepositLimit !== nextDay?.cents)
							return yield* fail(
								"PolicyLimitMismatch",
								"Executable deposit limit differs from the reviewed annual rule"
							)
						for (const component of [
							"EmployeeSS",
							"EmployerSS",
							"EmployeeMedicare",
							"EmployerMedicare",
							"FUTA"
						] as const) {
							const kind = component === "FUTA" ? "FUTAFullCredit" : component
							const published = data.rates.find((row) => row.annual === annual && row.kind === kind)
							const adopted = rates.find((row) => row.component === component)
							if (
								!published ||
								!adopted ||
								!(yield* sameSchedule(snapshot, published.schedule, adopted.schedule))
							)
								return yield* fail(
									"AnnualRateMismatch",
									`Executable ${component} differs from the reviewed annual rule`
								)
						}
					} else {
						const adopted = rates.find((row) => row.component === "SUTA")
						if (
							!adopted ||
							!(yield* relationRows(snapshot, S.EmployerSchedule)).some((row) => row.version === adopted.id)
						)
							return yield* fail(
								"EmployerRateMissing",
								"Install the evidenced assigned employer rate for this year"
							)
						const base = data.limits.find((row) => row.annual === annual && row.kind === "StateWageBase")
						const taxable = (yield* relationRows(snapshot, S.TaxBand)).filter(
							(row) => row.schedule === adopted.schedule && row.role === "WithinBase"
						)
						if (taxable.length !== 1 || taxable[0]?.span.start !== 0n || taxable[0]?.span.end !== base?.cents)
							return yield* fail(
								"AnnualWageBaseMismatch",
								"Employer schedule must use the reviewed state wage base"
							)
					}
					yield* draft.insert(S.AnnualApproval, [
						{
							annual,
							release,
							business,
							authority: policy.authority,
							year: policy.year,
							valid: policy.valid,
							evidence: input.evidence,
							recordedAt
						}
					])
					return {
						annual,
						release,
						authority: policy.authority,
						validFrom: policy.valid.start,
						validUntil: policy.valid.end
					}
				})
		})
	})
const sameSchedule = (snapshot: Snapshot, left: Uuid, right: Uuid) =>
	Effect.gen(function* () {
		const schedules = yield* relationRows(snapshot, S.RateSchedule),
			bands = yield* relationRows(snapshot, S.TaxBand)
		const a = schedules.find((row) => row.id === left),
			b = schedules.find((row) => row.id === right)
		if (!a || !b || a.denominator !== b.denominator) return false
		const entries = (id: Uuid) =>
			bands.filter((row) => row.schedule === id).sort((x, y) => (x.span.start < y.span.start ? -1 : 1))
		const x = entries(left),
			y = entries(right)
		return (
			x.length === y.length &&
			x.every(
				(row, i) =>
					row.span.start === y[i]?.span.start &&
					row.span.end === y[i]?.span.end &&
					row.numerator === y[i]?.numerator &&
					row.role === y[i]?.role
			)
		)
	})

export const approvedPoliciesAt = (snapshot: Snapshot, business: Uuid, release: Uuid, day: UnixEpochDay) =>
	Effect.gen(function* () {
		const approvals = (yield* relationRows(snapshot, S.AnnualApproval)).filter(
			(row) =>
				row.business === business && row.release === release && row.valid.start <= day && row.valid.end > day
		)
		if (!S.Authority.handles.every((authority) => approvals.some((row) => row.authority === authority)))
			return yield* fail(
				"AnnualPolicyRefreshRequired",
				"Refresh both federal and state policy for this pay year and release"
			)
		return approvals
	})

export const ElectionDocumentInput = Schema.Struct({
	...commandFields,
	...inputFields(S.ElectionDocument, ["employee", "year", "signedOn", "artifact", "evidence"], {
		year: Year,
		signedOn: Day
	}),
	supersedes: Schema.optional(Id),
	amounts: Schema.Record(
		Schema.Literals(S.ElectionContributionKind.handles),
		inputField(S.ElectionDocumentAmount.fields.cents)
	)
})

export const recordElectionDocument = (payload: unknown) =>
	Effect.gen(function* () {
		const input = parseStrict(ElectionDocumentInput, payload),
			business = input.business,
			employee = input.employee
		return yield* businessCommand({
			request: input.request,
			business,
			action: "election document",
			input: payload,
			plan: ({ snapshot, draft, recordedAt, recordingDay }) =>
				Effect.gen(function* () {
					if (
						!(yield* relationRows(snapshot, S.Employee)).some(
							(row) => row.id === employee && row.business === business
						)
					)
						return yield* fail("EmployeeMissing", "Select this business's employee")
					const signedOn = input.signedOn
					if (signedOn > recordingDay)
						return yield* fail("FutureEvidence", "The document has not been signed yet")
					const documents = (yield* relationRows(snapshot, S.ElectionDocument)).filter(
						(row) => row.employee === employee && row.year === input.year
					)
					const revisions = yield* relationRows(snapshot, S.ElectionDocumentRevision)
					const current = documents.filter(
						(row) => !revisions.some((revision) => revision.predecessor === row.id)
					)
					if (
						current.length &&
						(!input.supersedes || current.length !== 1 || current[0]?.id !== input.supersedes)
					)
						return yield* fail(
							"ElectionPredecessorRequired",
							"Name the current election document being replaced"
						)
					const predecessor = input.supersedes
						? documents.find((row) => row.id === input.supersedes)
						: undefined
					if (input.supersedes && (!predecessor || predecessor.signedOn > signedOn))
						return yield* fail(
							"ElectionOrderInvalid",
							"The replacement must belong to this employee and year and cannot predate its predecessor"
						)
					const document = yield* mintId
					yield* draft.insert(S.ElectionDocument, [
						{
							id: document,
							employee,
							year: input.year,
							signedOn: epochDay(signedOn),
							artifact: input.artifact,
							evidence: input.evidence,
							recordedAt
						}
					])
					if (predecessor)
						yield* draft.insert(S.ElectionDocumentRevision, [
							{ document, predecessor: predecessor.id, employee, year: input.year }
						])
					yield* draft.insert(
						S.ElectionDocumentAmount,
						S.ElectionContributionKind.handles.map((kind) => ({
							document,
							kind,
							cents: input.amounts[kind]
						}))
					)
					return { document }
				})
		})
	})
