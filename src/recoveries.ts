import type { Fact, QueryRow, Uuid } from "@bjornpagen/bumbledb"
import { Effect, Schema } from "effect"
import { businessCommand } from "./commands.ts"
import { epochDay, type UnixEpochDay } from "./core/time.ts"
import { json, mintId, Refusal, signed, unsigned } from "./core/values.ts"
import { currentAssessments, relationRows, rows } from "./queries.ts"
import { type Draft, parseStrict, type Snapshot } from "./runtime.ts"
import { commandFields, inputField, inputFields } from "./schema/input.ts"
import { componentPolicy, withholdingPolicy } from "./schema/vocabulary.ts"
import * as S from "./schema.ts"

export const RecoveryInput = Schema.Struct(
	inputFields(S.Recovery, ["owedOnWage", "component", "amount", "evidence"], {
		component: Schema.Literals(withholdingPolicy.map((row) => row.component)),
		amount: inputField(S.Recovery.fields.amount).check(
			Schema.makeFilter((value) => value > 0n || "A recovery must be positive")
		)
	})
)

export const recoveryEquation = (deducted: bigint, amounts: readonly bigint[]) => {
	const attributed = amounts.reduce((sum, amount) => signed(sum + signed(amount)), 0n)
	return { deducted, attributed, difference: signed(signed(deducted) - attributed) }
}

/** One employee-tax position for readiness, historical attribution and new pay.
 * A tax correction changes the assessment, never the actual deduction/payment.
 */
export const employeeTaxPositions = (
	assessed: readonly QueryRow<typeof currentAssessments>[],
	deductions: readonly Fact<typeof S.Deduction>[],
	recoveries: readonly Fact<typeof S.Recovery>[]
) =>
	assessed.flatMap((assessment) => {
		const policy = withholdingPolicy.find((row) => row.component === assessment.component)
		if (!policy) return []
		const withheld =
			deductions.find((row) => row.wage === assessment.wage && row.kind === policy.kind)?.amount ?? 0n
		const recovered = recoveries
			.filter((row) => row.owedOnWage === assessment.wage && row.component === assessment.component)
			.reduce((sum, row) => signed(sum + signed(row.amount)), 0n)
		return [
			{
				...assessment,
				withheld,
				recovered,
				remaining: signed(signed(assessment.amount) - signed(withheld) - recovered)
			}
		]
	})

/** Capture outstanding regular employee FICA at the calculation's exact state.
 * These are debts available for collection, not deductions already taken.
 * FIT is separately supplied; it is not inferred from historical differences.
 */
export const captureRecoveryClaims = (
	snapshot: Snapshot,
	employee: Uuid,
	paidOn: UnixEpochDay,
	evidence: string
) =>
	Effect.gen(function* () {
		const deducted = yield* relationRows(snapshot, S.Deduction)
		const recovered = yield* relationRows(snapshot, S.Recovery)
		const positions = employeeTaxPositions(yield* rows(snapshot, currentAssessments, {}), deducted, recovered)
		const unattributed = deducted.filter((row) => row.employee === employee && row.kind === "Recovery")
		if (
			unattributed.some(
				(row) =>
					recoveryEquation(
						row.amount,
						recovered.filter((r) => r.fromWage === row.wage).map((r) => r.amount)
					).difference !== 0n
			)
		)
			return yield* Effect.fail(
				new Refusal({
					code: "RecoveryUnattributed",
					message: "Attribute existing recovery deductions before calculating another collection"
				})
			)
		return positions
			.filter(
				(row) =>
					row.employee === employee &&
					row.paidOn.start <= paidOn &&
					row.remaining > 0n &&
					["SocialSecurity", "Medicare"].includes(componentPolicy[row.component].program)
			)
			.sort((a, b) =>
				a.paidOn.start < b.paidOn.start
					? -1
					: a.paidOn.start > b.paidOn.start
						? 1
						: a.wage.localeCompare(b.wage) || a.component.localeCompare(b.component)
			)
			.map((row) => ({
				owedOnWage: row.wage,
				employee,
				component: row.component,
				amount: row.remaining,
				evidence
			}))
	})

/** Later pay first covers current withholding, then prior employee FICA.
 * Roth must fit the remainder. No fabricated cash or tax liability is created.
 */
export const settlePaycheck = (
	gross: Fact<typeof S.Wage>["gross"],
	currentWithholding: Fact<typeof S.Deduction>["amount"],
	roth: Fact<typeof S.ProposedWage>["roth"],
	claims: readonly Omit<Fact<typeof S.CalculationRecoveryClaim>, "calculation" | "set">[]
) => {
	let available = gross - currentWithholding
	if (available < 0n)
		throw new Refusal({ code: "InsufficientGross", message: "Current withholding exceeds gross wages" })
	const recoveries = claims.flatMap((claim) => {
		const amount = claim.amount < available ? claim.amount : available
		available -= amount
		return amount > 0n ? [{ ...claim, amount }] : []
	})
	if (roth > available)
		throw new Refusal({
			code: "InsufficientNetForRoth",
			message:
				"Requested Roth exceeds wages remaining after current withholding and automatic employee FICA recovery"
		})
	return {
		recoveries,
		recovery: recoveries.reduce((n, row) => n + row.amount, 0n),
		roth,
		cash: available - roth
	}
}

/** Actual observations may retain excess collection; never invent a deduction. */
const admitRecoveries = (
	snapshot: Snapshot,
	input: readonly (typeof RecoveryInput.Type)[],
	employee: Uuid,
	paidOn: UnixEpochDay
) =>
	Effect.gen(function* () {
		const keys = input.map((row) => json([row.owedOnWage, row.component]))
		if (new Set(keys).size !== keys.length)
			return yield* Effect.fail(
				new Refusal({ code: "DuplicateRecovery", message: "Attribute each original wage/component once" })
			)
		const wages = yield* relationRows(snapshot, S.Wage)
		return input.map((row) => {
			if (
				!wages.some(
					(wage) => wage.id === row.owedOnWage && wage.employee === employee && wage.paidOn.start <= paidOn
				)
			)
				throw new Refusal({
					code: "RecoveryScope",
					message: "A recovery must name this employee's existing wage on or before the collecting pay date"
				})
			return { ...row, employee }
		})
	})

export const recoveryFacts = (
	draft: Draft,
	fromWage: Uuid,
	input: readonly Omit<Fact<typeof S.Recovery>, "id" | "fromWage" | "kind">[]
) =>
	Effect.gen(function* () {
		for (const row of input)
			yield* draft.insert(S.Recovery, [{ ...row, id: yield* mintId, fromWage, kind: "Recovery" }])
		return input.reduce((sum, row) => unsigned(sum + row.amount), 0n)
	})

const RecordInput = Schema.Struct({
	...commandFields,
	...inputFields(S.Recovery, ["evidence"]),
	wage: inputField(S.Recovery.fields.fromWage),
	recoveries: Schema.Array(RecoveryInput)
})
/** Attributes an existing actual recovery deduction; does not change cash. */
export const recordRecovery = (payload: unknown) =>
	Effect.gen(function* () {
		const input = parseStrict(RecordInput, payload),
			business = input.business
		return yield* businessCommand({
			request: input.request,
			business,
			action: "recovery record",
			input: payload,
			plan: ({ snapshot, draft, recordingDay }) =>
				Effect.gen(function* () {
					const wage = (yield* relationRows(snapshot, S.Wage)).find(
						(row) => row.id === input.wage && row.business === business
					)
					if (!wage || wage.paidOn.start > recordingDay)
						return yield* Effect.fail(
							new Refusal({
								code: "RecoveryScope",
								message: "Select an existing paid wage for this business"
							})
						)
					const actual = (yield* relationRows(snapshot, S.Deduction)).find(
						(row) => row.wage === wage.id && row.kind === "Recovery"
					)
					if (!actual || actual.amount === 0n)
						return yield* Effect.fail(
							new Refusal({
								code: "RecoveryDeductionMissing",
								message: "This wage has no actual recovery deduction to attribute"
							})
						)
					if ((yield* relationRows(snapshot, S.Recovery)).some((row) => row.fromWage === wage.id))
						return yield* Effect.fail(
							new Refusal({
								code: "RecoveryAlreadyAttributed",
								message: "This wage's recovery attribution is already recorded"
							})
						)
					const admitted = yield* admitRecoveries(
						snapshot,
						input.recoveries,
						wage.employee,
						epochDay(wage.paidOn.start)
					)
					if (
						recoveryEquation(
							actual.amount,
							admitted.map((row) => row.amount)
						).difference !== 0n
					)
						return yield* Effect.fail(
							new Refusal({
								code: "RecoveryReconciliation",
								message: "Attributions must exactly explain the actual recovery deduction"
							})
						)
					yield* recoveryFacts(draft, wage.id, admitted)
					return { wage: wage.id, evidence: input.evidence }
				})
		})
	})
