import type { Fact, Uuid } from "@bjornpagen/bumbledb"
import { Effect, Schema } from "effect"
import { businessCommand } from "./commands.ts"
import { civilDaySpan, epochDay, periodSpan, toCalendarDate } from "./core/time.ts"
import { mintId, Refusal } from "./core/values.ts"
import { followingBusinessDay, nominalDeadline } from "./policy/calendar.ts"
import { currentRevisions, relationRows, rows } from "./queries.ts"
import { type Draft, parseStrict, type Snapshot } from "./runtime.ts"
import { commandFields, Day, Id, inputFields, YearNumber } from "./schema/input.ts"
import { formPolicy, forms, retirementForms } from "./schema/vocabulary.ts"
import * as S from "./schema.ts"

export const FilingEnsureInput = Schema.Struct({
	...commandFields,
	throughYear: YearNumber,
	enrollment: Schema.optional(
		Schema.Struct(inputFields(S.FilingRequirement, ["startsOn", "evidence"], { startsOn: Day }))
	)
})
type Enrollment = (typeof FilingEnsureInput.Type)["enrollment"]

/** This one planner is used by ensure, enrollment, and wage posting. Reads
 * never materialize filings. A new wage contributes its employee/year to this
 * planner in the same draft so its first applicable W-2 cannot be omitted.
 */
export const ensureFilingFacts = (
	snapshot: Snapshot,
	draft: Draft,
	options: {
		business: Uuid
		throughYear: number
		enrollment?: Enrollment
		additionalPaidEmployees?: readonly { employee: Uuid; year: number }[]
	}
) =>
	Effect.gen(function* () {
		const business = options.business,
			horizon = periodSpan(options.throughYear, "Year").end
		const binding = (yield* relationRows(snapshot, S.PolicyBinding)).find((row) => row.business === business)
		if (!binding)
			return yield* Effect.fail(
				new Refusal({
					code: "PolicyMissing",
					message: "Activate a reviewed filing calendar before ensuring coverage"
				})
			)
		const existingRequirements = yield* relationRows(snapshot, S.FilingRequirement)
		const requirementEnds = yield* relationRows(snapshot, S.RequirementEnd)
		const existingScopes = yield* relationRows(snapshot, S.FilingScope)
		const existingOriginals = yield* relationRows(snapshot, S.OriginalFiling)
		const existingBusiness = (yield* relationRows(snapshot, S.BusinessSubject)).find(
			(row) => row.business === business
		)
		const existingEmployees = (yield* relationRows(snapshot, S.EmployeeSubject)).filter(
			(row) => row.business === business
		)
		const currentRules = (yield* relationRows(snapshot, S.FilingRule)).filter(
			(row) => row.release === binding.release
		)
		const calendar = (yield* relationRows(snapshot, S.CalendarPeriod)).filter(
			(row) => row.release === binding.release
		)
		const wages = (yield* rows(snapshot, currentRevisions, {})).filter((row) => row.business === business)
		const paid = [
			...wages.map((row) => ({
				employee: row.employee,
				year: toCalendarDate(epochDay(row.paidOn.start)).year
			})),
			...(options.additionalPaidEmployees ?? [])
		].filter((row) => row.year <= options.throughYear)
		const employeeYears = new Map<Uuid, number[]>()
		for (const row of paid)
			employeeYears.set(row.employee, [...(employeeYears.get(row.employee) ?? []), row.year])
		const companySubject = existingBusiness?.subject ?? (yield* mintId)
		if (!existingBusiness) {
			yield* draft.insert(S.FilingSubject, [{ id: companySubject, business, kind: "Business" }])
			yield* draft.insert(S.BusinessSubject, [{ subject: companySubject, business }])
		}
		const employeeSubjectIds = new Map<Uuid, Uuid>()
		for (const employee of employeeYears.keys()) {
			const existing = existingEmployees.find((row) => row.employee === employee)
			const subject = existing?.subject ?? (yield* mintId)
			employeeSubjectIds.set(employee, subject)
			if (!existing) {
				yield* draft.insert(S.FilingSubject, [{ id: subject, business, kind: "Employee" }])
				yield* draft.insert(S.EmployeeSubject, [{ subject, employee, business }])
			}
		}
		let created = 0n
		for (const form of forms.filter((form) => formPolicy[form].due !== "RecordedEvent")) {
			const rule = currentRules.find((row) => row.form === form)
			if (!rule)
				return yield* Effect.fail(
					new Refusal({
						code: "FilingRuleMissing",
						message: `Install the reviewed ${form} rule before ensuring filings`
					})
				)
			let requirement = existingRequirements.find((row) => row.business === business && row.form === form)
			if (!requirement) {
				if (!options.enrollment)
					return yield* Effect.fail(
						new Refusal({
							code: "EnrollmentMissing",
							message: "Supply the evidenced beginning of filing obligations for initial enrollment"
						})
					)
				requirement = {
					id: yield* mintId,
					business,
					form,
					subjectKind: formPolicy[form].subject,
					startsOn: options.enrollment.startsOn,
					evidence: options.enrollment.evidence
				}
				yield* draft.insert(S.FilingRequirement, [requirement])
			}
			const end = requirementEnds.find((row) => row.requirement === requirement.id)?.endsBefore ?? horizon
			const requestedEnd = end < horizon ? end : horizon
			if (requestedEnd <= requirement.startsOn) continue
			const subjects: { subject: Uuid; from: bigint; through: bigint }[] =
				requirement.subjectKind === "Business"
					? [{ subject: companySubject, from: requirement.startsOn, through: requestedEnd }]
					: [...employeeYears].map(([employee, years]) => {
							const subject = employeeSubjectIds.get(employee)
							if (!subject)
								throw new Refusal({
									code: "SubjectMissing",
									message: "The employee filing subject was not planned"
								})
							const first = periodSpan(Math.min(...years), "Year").start,
								last = periodSpan(Math.max(...years), "Year").end
							return {
								subject,
								from: first > requirement.startsOn ? first : requirement.startsOn,
								through: last < requestedEnd ? last : requestedEnd
							}
						})
			for (const target of subjects) {
				if (target.from >= target.through) continue
				const old = existingScopes.find(
					(row) => row.requirement === requirement.id && row.subject === target.subject
				)
				const from = old && old.span.start < target.from ? old.span.start : target.from
				const through = old && old.span.end > target.through ? old.span.end : target.through
				const covered = calendar
					.filter(
						(row) =>
							row.authority === rule.authority &&
							row.kind === rule.periodKind &&
							row.span.end > from &&
							row.span.start < through
					)
					.sort((a, b) => (a.span.start < b.span.start ? -1 : 1))
				const first = covered[0],
					last = covered.at(-1)
				if (!first || !last || first.span.start > from || last.span.end < through)
					return yield* Effect.fail(
						new Refusal({
							code: "CalendarCoverageMissing",
							message: `The active calendar does not cover the ${form} filing horizon`
						})
					)
				const span = civilDaySpan(epochDay(first.span.start), epochDay(last.span.end))
				const scope: Fact<typeof S.FilingScope> = {
					id: old?.id ?? (yield* mintId),
					requirement: requirement.id,
					subject: target.subject,
					business,
					form,
					kind: rule.periodKind,
					span
				}
				if (!old || old.span.start !== span.start || old.span.end !== span.end) {
					if (old) yield* draft.delete(S.FilingScope, [old])
					yield* draft.insert(S.FilingScope, [scope])
				}
				for (const canonical of covered) {
					if (
						existingOriginals.some(
							(row) =>
								row.scope === scope.id &&
								row.period.start === canonical.span.start &&
								row.period.end === canonical.span.end
						)
					)
						continue
					const dueOn = yield* followingBusinessDay(
						snapshot,
						binding.release,
						rule.authority,
						nominalDeadline(rule.dueRule, epochDay(canonical.span.end))
					)
					const filing = yield* mintId
					yield* draft.insert(S.Filing, [
						{
							id: filing,
							requirement: requirement.id,
							subject: target.subject,
							business,
							form,
							period: canonical.span,
							kind: "Original",
							opensOn: canonical.span.end,
							dueOn,
							evidence: rule.evidence
						}
					])
					yield* draft.insert(S.OriginalFiling, [
						{
							filing,
							scope: scope.id,
							requirement: requirement.id,
							subject: target.subject,
							business,
							form,
							canonical: canonical.id,
							kind: rule.periodKind,
							period: canonical.span
						}
					])
					created++
				}
			}
		}
		return { business, createdFilings: created, throughYear: BigInt(options.throughYear) }
	})

export const ensureFilings = (payload: unknown) =>
	Effect.gen(function* () {
		const input = parseStrict(FilingEnsureInput, payload),
			business = input.business
		return yield* businessCommand({
			request: input.request,
			business,
			action: "filings ensure",
			input: payload,
			plan: ({ snapshot, draft }) =>
				ensureFilingFacts(snapshot, draft, {
					business,
					throughYear: input.throughYear,
					enrollment: input.enrollment
				})
		})
	})

export const expectRetirementFiling = (payload: unknown) =>
	Effect.gen(function* () {
		const input = parseStrict(
			Schema.Struct({
				...commandFields,
				plan: Id,
				...inputFields(S.Filing, ["form", "opensOn", "dueOn", "evidence"], {
					form: Schema.Literals(retirementForms),
					opensOn: Day,
					dueOn: Day
				}),
				year: YearNumber
			}),
			payload
		)
		const business = input.business
		return yield* businessCommand({
			request: input.request,
			business,
			action: "filings expect-retirement",
			input: payload,
			plan: ({ snapshot, draft }) =>
				Effect.gen(function* () {
					const plan = (yield* relationRows(snapshot, S.RetirementPlan)).find(
						(r) => r.id === input.plan && r.business === business
					)
					if (!plan)
						throw new Refusal({ code: "PlanMissing", message: "Select this business's retirement plan" })
					const span = periodSpan(input.year, "Year"),
						existingSubject = (yield* relationRows(snapshot, S.PlanSubject)).find((r) => r.plan === plan.id),
						subject = existingSubject?.subject ?? (yield* mintId)
					if (!existingSubject) {
						yield* draft.insert(S.FilingSubject, [{ id: subject, business, kind: "Plan" }])
						yield* draft.insert(S.PlanSubject, [{ subject, plan: plan.id, business }])
					}
					const binding = (yield* relationRows(snapshot, S.PolicyBinding)).find(
						(r) => r.business === business
					)
					const calendar = (yield* relationRows(snapshot, S.CalendarPeriod)).find(
						(r) =>
							r.release === binding?.release &&
							r.authority === "FederalDC" &&
							r.kind === "Year" &&
							r.year === BigInt(input.year)
					)
					if (!calendar)
						throw new Refusal({
							code: "CalendarCoverageMissing",
							message: "Install the filing year's reviewed calendar"
						})
					const existingRequirement = (yield* relationRows(snapshot, S.FilingRequirement)).find(
							(r) => r.business === business && r.form === input.form
						),
						requirement = existingRequirement?.id ?? (yield* mintId)
					if (!existingRequirement)
						yield* draft.insert(S.FilingRequirement, [
							{
								id: requirement,
								business,
								form: input.form,
								subjectKind: "Plan",
								startsOn: span.start,
								evidence: input.evidence
							}
						])
					const existingScope = (yield* relationRows(snapshot, S.FilingScope)).find(
							(r) => r.requirement === requirement && r.subject === subject
						),
						scope = existingScope?.id ?? (yield* mintId)
					const covered = existingScope
						? civilDaySpan(
								epochDay(existingScope.span.start < span.start ? existingScope.span.start : span.start),
								epochDay(existingScope.span.end > span.end ? existingScope.span.end : span.end)
							)
						: span
					if (existingScope) yield* draft.delete(S.FilingScope, [existingScope])
					yield* draft.insert(S.FilingScope, [
						{ id: scope, requirement, subject, business, form: input.form, kind: "Year", span: covered }
					])
					const existing = (yield* relationRows(snapshot, S.OriginalFiling)).find(
						(r) => r.scope === scope && r.canonical === calendar.id
					)
					if (existing) return { filing: existing.filing }
					const filing = yield* mintId
					yield* draft.insert(S.Filing, [
						{
							id: filing,
							requirement,
							subject,
							business,
							form: input.form,
							period: span,
							kind: "Original",
							opensOn: input.opensOn,
							dueOn: input.dueOn,
							evidence: input.evidence
						}
					])
					yield* draft.insert(S.OriginalFiling, [
						{
							filing,
							scope,
							requirement,
							subject,
							business,
							form: input.form,
							canonical: calendar.id,
							kind: "Year",
							period: span
						}
					])
					return { filing }
				})
		})
	})
