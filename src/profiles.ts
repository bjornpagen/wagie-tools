import type { Uuid } from "@bjornpagen/bumbledb"
import { Effect, Schema } from "effect"
import { businessCommand, statementWriter } from "./commands.ts"
import { civilDaySpan, epochDay, today } from "./core/time.ts"
import { mintId, Nonblank, Refusal } from "./core/values.ts"
import { exists, first, relationRows, select } from "./queries.ts"
import { parseStrict, planAndCommit, type Snapshot } from "./runtime.ts"
import { commandFields, Day, Id, inputFields } from "./schema/input.ts"
import * as S from "./schema.ts"

const AddressInput = Schema.Struct(
	inputFields(S.BusinessAddress, ["kind", "street", "city", "state", "zip", "country"])
)
export const BusinessInput = Schema.Struct({
	request: Id,
	business: Schema.optional(Id),
	...inputFields(S.Business, ["name", "ein", "state", "timeZone"]),
	addresses: Schema.Array(AddressInput),
	stateAccount: Schema.optional(Nonblank),
	evidence: Nonblank
})
export const EmployeeInput = Schema.Struct({
	...commandFields,
	employee: Schema.optional(Id),
	...inputFields(S.Employee, ["firstName", "lastName", "ssn", "address", "filingStatus"]),
	evidence: Nonblank
})
export const BudgetInput = Schema.Struct({
	...commandFields,
	...inputFields(S.AnnualBudget, ["employee", "year", "limit", "evidence"])
})
export const AssignmentInput = Schema.Struct({
	...commandFields,
	...inputFields(S.BudgetAssignment, ["commitment"]),
	evidence: Nonblank
})
export const ElectionInput = Schema.Struct({
	...commandFields,
	...inputFields(S.ElectionSource, ["document"]),
	effectiveOn: Day
})

const employeeFor = (snapshot: Snapshot, business: Uuid, employee: Uuid) =>
	Effect.gen(function* () {
		const row = yield* first(snapshot, S.Employee, { id: employee, business })
		if (!row)
			return yield* Effect.fail(
				new Refusal({ code: "EmployeeMissing", message: "Select an employee of this business" })
			)
		return row
	})

export const configureBusiness = (payload: unknown) =>
	Effect.gen(function* () {
		const input = parseStrict(BusinessInput, payload),
			request = input.request
		const recordingDay = yield* today(input.timeZone)
		if (new Set(input.addresses.map((row) => row.kind)).size !== input.addresses.length)
			return yield* Effect.fail(
				new Refusal({ code: "DuplicateAddressKind", message: "Supply each address kind once" })
			)
		return yield* planAndCommit({
			request,
			action: "business configure",
			input: payload,
			recordingDay,
			timeZone: input.timeZone,
			plan: (snapshot, draft) =>
				Effect.gen(function* () {
					const note = statementWriter(draft)
					const existing = input.business
						? yield* first(snapshot, S.Business, { id: input.business })
						: yield* first(snapshot, S.Business, { ein: input.ein })
					if (input.business && !existing)
						return yield* Effect.fail(
							new Refusal({ code: "BusinessMissing", message: "The selected business does not exist" })
						)
					const business = existing?.id ?? (yield* mintId)
					if (existing) yield* draft.delete(S.Business, [existing])
					yield* draft.insert(S.Business, [
						{
							id: business,
							name: input.name,
							ein: input.ein,
							state: input.state,
							timeZone: input.timeZone
						}
					])
					const oldAddresses = yield* select(snapshot, S.BusinessAddress, { business })
					for (const address of input.addresses) {
						const old = oldAddresses.find((row) => row.kind === address.kind)
						if (old) yield* draft.delete(S.BusinessAddress, [old])
						yield* draft.insert(S.BusinessAddress, [{ business, ...address }])
					}
					if (input.stateAccount) {
						const old = yield* first(snapshot, S.StateAccount, { business, state: input.state })
						if (old) yield* draft.delete(S.StateAccount, [old])
						yield* draft.insert(S.StateAccount, [
							{
								business,
								state: input.state,
								taxpayerNumber: input.stateAccount,
								evidence: yield* note(input.evidence)
							}
						])
					}
					const existingAccounts = yield* select(snapshot, S.TaxAccount, { business })
					for (const family of S.AccountFamily.handles)
						if (!existingAccounts.some((row) => row.family === family))
							yield* draft.insert(S.TaxAccount, [
								{ id: yield* mintId, business, family, evidence: yield* note(input.evidence) }
							])
					return { business }
				})
		})
	})

export const recordEmployee = (payload: unknown) =>
	Effect.gen(function* () {
		const input = parseStrict(EmployeeInput, payload),
			business = input.business
		return yield* businessCommand({
			request: input.request,
			business,
			action: "employee record",
			input: payload,
			plan: ({ snapshot, draft }) =>
				Effect.gen(function* () {
					const existing = input.employee
						? yield* employeeFor(snapshot, business, input.employee)
						: yield* first(snapshot, S.Employee, { business, ssn: input.ssn })
					const employee = existing?.id ?? (yield* mintId)
					if (existing) yield* draft.delete(S.Employee, [existing])
					yield* draft.insert(S.Employee, [
						{
							id: employee,
							business,
							firstName: input.firstName,
							lastName: input.lastName,
							ssn: input.ssn,
							address: input.address,
							filingStatus: input.filingStatus
						}
					])
					return { employee, business }
				})
		})
	})

/** Only explicit evidenced input changes an annual limit. Native capacity
 * judges the already-assigned commitments; it cannot be bypassed by lowering it.
 */
export const recordBudget = (payload: unknown) =>
	Effect.gen(function* () {
		const input = parseStrict(BudgetInput, payload),
			business = input.business,
			employee = input.employee,
			year = input.year
		return yield* businessCommand({
			request: input.request,
			business,
			action: "compensation budget",
			input: payload,
			plan: ({ snapshot, draft, note }) =>
				Effect.gen(function* () {
					yield* employeeFor(snapshot, business, employee)
					const existing = yield* first(snapshot, S.AnnualBudget, { employee, year })
					const budget = existing?.id ?? (yield* mintId)
					if (existing) yield* draft.delete(S.AnnualBudget, [existing])
					yield* draft.insert(S.AnnualBudget, [
						{ id: budget, employee, year, limit: input.limit, evidence: yield* note(input.evidence) }
					])
					return { budget, employee, year }
				})
		})
	})

export const assignCompensation = (payload: unknown) =>
	Effect.gen(function* () {
		const input = parseStrict(AssignmentInput, payload),
			business = input.business
		return yield* businessCommand({
			request: input.request,
			business,
			action: "compensation assign",
			input: payload,
			plan: ({ snapshot, draft }) =>
				Effect.gen(function* () {
					const commitment = yield* first(snapshot, S.BudgetCommitment, { id: input.commitment })
					if (!commitment)
						return yield* Effect.fail(
							new Refusal({
								code: "CommitmentMissing",
								message: "Select the recorded compensation commitment"
							})
						)
					yield* employeeFor(snapshot, business, commitment.employee)
					const budget = yield* first(snapshot, S.AnnualBudget, {
						employee: commitment.employee,
						year: commitment.year
					})
					if (!budget)
						return yield* Effect.fail(
							new Refusal({
								code: "BudgetMissing",
								message: "Record the evidenced annual budget before assignment; the movement remains recorded"
							})
						)
					const assigned = yield* first(snapshot, S.BudgetAssignment, { commitment: commitment.id })
					if (!assigned)
						yield* draft.insert(S.BudgetAssignment, [
							{
								commitment: commitment.id,
								budget: budget.id,
								employee: commitment.employee,
								year: commitment.year,
								amount: commitment.amount
							}
						])
					return { commitment: commitment.id, budget: budget.id }
				})
		})
	})

/** Activate a signed election without repeating its dates, year or targets.
 * The annual allowance is shared by every election and all historical Roth.
 */
export const recordElection = (payload: unknown) =>
	Effect.gen(function* () {
		const input = parseStrict(ElectionInput, payload),
			business = input.business
		return yield* businessCommand({
			request: input.request,
			business,
			action: "election record",
			input: payload,
			plan: ({ snapshot, draft, recordingDay }) =>
				Effect.gen(function* () {
					const document = yield* first(snapshot, S.ElectionDocument, { id: input.document })
					if (!document)
						return yield* Effect.fail(
							new Refusal({
								code: "ElectionDocumentMissing",
								message: "Select the recorded signed election document"
							})
						)
					const { employee, year, signedOn, evidence } = document
					yield* employeeFor(snapshot, business, employee)
					if (yield* exists(snapshot, S.ElectionDocumentRevision, { predecessor: document.id }))
						return yield* Effect.fail(
							new Refusal({ code: "ElectionSuperseded", message: "Select the current signed document" })
						)
					if (signedOn > recordingDay || signedOn > input.effectiveOn)
						return yield* Effect.fail(
							new Refusal({
								code: "ElectionDate",
								message: "An election cannot take effect before signing or assert a future signing"
							})
						)
					const annual = yield* first(snapshot, S.RetirementAnnual, { employee, year })
					const binding = yield* first(snapshot, S.PolicyBinding, { business })
					const policy =
						binding && (yield* first(snapshot, S.DeferralPolicy, { release: binding.release, year }))
					const calendar =
						binding &&
						(yield* first(snapshot, S.CalendarPeriod, {
							release: binding.release,
							year,
							kind: "Year",
							authority: "FederalDC"
						}))
					if (!annual || !policy || !calendar)
						return yield* Effect.fail(
							new Refusal({
								code: "DeferralPolicyMissing",
								message: "Record the annual retirement review, deferral policy and calendar first"
							})
						)
					if (
						annual.otherPlans ||
						annual.outsideAssets ||
						annual.outsideDeferrals > annual.deferralLimit ||
						annual.deferralLimit !== policy.limit
					)
						return yield* Effect.fail(
							new Refusal({
								code: "RetirementScope",
								message:
									"Annual review must agree with the active deferral policy and supported single-plan scope"
							})
						)
					if (input.effectiveOn < calendar.span.start || input.effectiveOn >= calendar.span.end)
						return yield* Effect.fail(
							new Refusal({
								code: "ElectionDate",
								message: "The effective date must fall within the document's calendar year"
							})
						)
					const elected = yield* first(snapshot, S.ElectionDocumentAmount, {
						document: document.id,
						kind: "Roth"
					})
					if (!elected)
						return yield* Effect.fail(
							new Refusal({
								code: "ElectionAmountMissing",
								message: "The signed document has no Roth amount"
							})
						)
					const limit = annual.deferralLimit - annual.outsideDeferrals
					const existing = yield* first(snapshot, S.EmployeeAllowance, { employee, year })
					if (existing && (existing.limit !== limit || existing.policy !== policy.id))
						return yield* Effect.fail(
							new Refusal({
								code: "AllowanceConflict",
								message: "Resolve the changed annual allowance before replacing the election"
							})
						)
					const allowance = existing?.id ?? (yield* mintId),
						election = yield* mintId
					if (!existing)
						yield* draft.insert(S.EmployeeAllowance, [
							{
								id: allowance,
								employee,
								year,
								policy: policy.id,
								maximum: policy.limit,
								limit,
								evidence: annual.evidence
							}
						])
					// A replacement closes the prior authorization; historical uses stay attached.
					for (const old of (yield* select(snapshot, S.Election, { employee, year })).filter(
						(row) => row.effective.end > input.effectiveOn
					)) {
						if (old.effective.start >= input.effectiveOn)
							return yield* Effect.fail(
								new Refusal({
									code: "ElectionOverlap",
									message: "A replacement must start after the existing authorization's start"
								})
							)
						yield* draft.delete(S.Election, [old])
						yield* draft.insert(S.Election, [
							{ ...old, effective: civilDaySpan(epochDay(old.effective.start), input.effectiveOn) }
						])
					}
					yield* draft.insert(S.Election, [
						{
							id: election,
							employee,
							year,
							calendar: calendar.id,
							allowance,
							maximum: limit,
							signedOn,
							effective: civilDaySpan(input.effectiveOn, epochDay(calendar.span.end)),
							limit: elected.amount,
							evidence
						}
					])
					yield* draft.insert(S.ElectionSource, [
						{
							election,
							document: document.id,
							annual: annual.id,
							employee,
							year,
							signedOn,
							kind: "Roth",
							limit: elected.amount
						}
					])
					return { election, allowance, employee, year }
				})
		})
	})

export const inspectProfiles = (snapshot: Snapshot, business: Uuid) =>
	Effect.gen(function* () {
		const company = yield* first(snapshot, S.Business, { id: business })
		if (!company)
			return yield* Effect.fail(new Refusal({ code: "BusinessMissing", message: "No matching business" }))
		const people = yield* select(snapshot, S.Employee, { business }),
			ids = new Set(people.map((row) => row.id))
		const documents = (yield* relationRows(snapshot, S.ElectionDocument)).filter((row) =>
			ids.has(row.employee)
		)
		const documentRevisions = (yield* relationRows(snapshot, S.ElectionDocumentRevision)).filter((row) =>
			ids.has(row.employee)
		)
		const documentIds = new Set(documents.map((row) => row.id))
		return {
			business: company,
			employees: people,
			currentElectionDocuments: documents.filter(
				(row) => !documentRevisions.some((revision) => revision.predecessor === row.id)
			),
			electionDocumentRevisions: documentRevisions,
			electionDocuments: documents,
			elections: (yield* relationRows(snapshot, S.Election)).filter((row) => ids.has(row.employee)),
			electionSources: (yield* relationRows(snapshot, S.ElectionSource)).filter((row) =>
				ids.has(row.employee)
			),
			employeeAllowances: (yield* relationRows(snapshot, S.EmployeeAllowance)).filter((row) =>
				ids.has(row.employee)
			),
			electionDocumentAmounts: (yield* relationRows(snapshot, S.ElectionDocumentAmount)).filter((row) =>
				documentIds.has(row.document)
			),
			addresses: yield* select(snapshot, S.BusinessAddress, { business }),
			accounts: yield* select(snapshot, S.TaxAccount, { business }),
			stateAccounts: yield* select(snapshot, S.StateAccount, { business }),
			budgets: (yield* relationRows(snapshot, S.AnnualBudget)).filter((row) => ids.has(row.employee))
		}
	})
