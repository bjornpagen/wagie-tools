import type { IntervalValue, Uuid } from "@bjornpagen/bumbledb"
import { Effect, Schema } from "effect"
import { businessCommand } from "./commands.ts"
import { civilDayPoint, epochDay, periodSpan, toCalendarDate, type UnixEpochDay } from "./core/time.ts"
import { entityId, json, mintId, Nonblank, Refusal } from "./core/values.ts"
import { relationRows } from "./queries.ts"
import { fingerprint, parseStrict, type Snapshot } from "./runtime.ts"
import * as S from "./schema.ts"

const sum = (rows: readonly { amount: bigint }[]) => rows.reduce((n, row) => n + row.amount, 0n)
const minimum = (...values: bigint[]) => values.reduce((a, b) => (a < b ? a : b))
const required = <A>(value: A | undefined, message: string) =>
	value === undefined
		? Effect.fail(new Refusal({ code: "BookkeepingScope", message }))
		: Effect.succeed(value)

const positive = (amount: bigint) => {
	if (amount === 0n) throw new Refusal({ code: "PositiveAmount", message: "Record a positive actual amount" })
	return amount
}

/** One receipt reconciliation used by both funding admission and the register. */
export const receiptDiscrepancies = (snapshot: Snapshot, plan: Uuid) =>
	Effect.gen(function* () {
		const receipts = (yield* relationRows(snapshot, S.PlanReceipt)).filter((r) => r.plan === plan)
		const contributions = yield* relationRows(snapshot, S.RetirementContribution)
		const allocations = yield* relationRows(snapshot, S.ReceiptAllocation)
		const accounts = yield* relationRows(snapshot, S.PlanAccount)
		const conversions = yield* relationRows(snapshot, S.RothConversion)
		return receipts.flatMap((receipt) => {
			const links = allocations.filter((r) => r.receipt === receipt.id)
			const account = accounts.find((r) => r.id === receipt.account)
			const mismatched = links.some((link) =>
				contributions.some(
					(c) => c.id === link.contribution && (c.source !== receipt.source || c.year !== receipt.year)
				)
			)
			const accountMismatch =
				account?.kind !== (receipt.source === "EmployeeAfterTax" ? "AfterTax" : "Roth") &&
				!conversions.some(
					(r) =>
						receipt.source === "EmployeeAfterTax" &&
						r.operation === receipt.operation &&
						r.toAccount === receipt.account
				)
			return mismatched || accountMismatch || sum(links) !== receipt.amount
				? [
						{
							receipt,
							detail:
								mismatched || accountMismatch
									? "Provider source, account, or year differs from the contribution record"
									: "Provider receipt is not fully allocated to contributions"
						}
					]
				: []
		})
	})

/** A stage is not another contribution. Payroll Roth is counted from deductions;
 * the matching contribution identity merely connects funding and receipt. */
export const retirementPosition = (snapshot: Snapshot, planId: Uuid, year: number) =>
	Effect.gen(function* () {
		const plan = yield* required(
			(yield* relationRows(snapshot, S.RetirementPlan)).find((r) => r.id === planId),
			"Select a retirement plan"
		)
		const annual = (yield* relationRows(snapshot, S.RetirementAnnual)).find(
			(r) => r.plan === plan.id && r.year === BigInt(year)
		)
		const wages = (yield* relationRows(snapshot, S.Wage)).filter(
			(r) => r.employee === plan.employee && r.year === BigInt(year)
		)
		const deductions = (yield* relationRows(snapshot, S.Deduction)).filter(
			(r) => r.employee === plan.employee && r.year === BigInt(year) && r.kind === "Roth"
		)
		const cancelled = new Set(
			(yield* relationRows(snapshot, S.ContributionCancellation)).map((r) => r.contribution)
		)
		const contributions = (yield* relationRows(snapshot, S.RetirementContribution)).filter(
			(r) => r.plan === plan.id && r.year === BigInt(year) && !cancelled.has(r.id)
		)
		const roth = sum(deductions)
		const afterTax = sum(contributions.filter((r) => r.source === "EmployeeAfterTax"))
		const compensation = wages.reduce((n, r) => n + r.gross, 0n)
		const superseded = new Set(
			(yield* relationRows(snapshot, S.ElectionDocumentRevision)).map((r) => r.predecessor)
		)
		const election = (yield* relationRows(snapshot, S.ElectionDocument)).find(
			(r) => r.employee === plan.employee && r.year === BigInt(year) && !superseded.has(r.id)
		)
		const elected = yield* relationRows(snapshot, S.ElectionDocumentAmount)
		const rothTarget = elected.find((r) => r.document === election?.id && r.kind === "Roth")?.cents
		const afterTaxTarget = elected.find(
			(r) => r.document === election?.id && r.kind === "OptionalAfterTax"
		)?.cents
		const statutory = annual
			? {
					deferralsRemaining: annual.deferralLimit - annual.outsideDeferrals - roth,
					additionsRemaining:
						minimum(annual.additionsLimit, annual.compensationCap, compensation) -
						annual.outsideAdditions -
						roth -
						afterTax,
					dollarCeilingRemaining: annual.additionsLimit - annual.outsideAdditions - roth - afterTax
				}
			: undefined
		return {
			plan,
			year,
			annual,
			election,
			compensation,
			roth,
			afterTax,
			contributions,
			remainingRothTarget: rothTarget === undefined ? undefined : rothTarget - roth,
			remainingAfterTaxTarget: afterTaxTarget === undefined ? undefined : afterTaxTarget - afterTax,
			statutory
		}
	})

export const admitContribution = (
	snapshot: Snapshot,
	plan: Uuid,
	source: (typeof S.ContributionSource.handles)[number],
	amount: bigint,
	day: UnixEpochDay,
	newCompensation = 0n
) =>
	Effect.gen(function* () {
		const position = yield* retirementPosition(snapshot, plan, toCalendarDate(day).year)
		if ((yield* receiptDiscrepancies(snapshot, plan)).length > 0)
			return yield* Effect.fail(
				new Refusal({
					code: "ReceiptReconciliation",
					message: "Reconcile provider receipt records before authorizing more contributions"
				})
			)
		const resolvedIssues = new Set(
			(yield* relationRows(snapshot, S.BookkeepingResolution)).map((r) => r.issue)
		)
		if (
			(yield* relationRows(snapshot, S.BookkeepingIssue)).some(
				(r) => r.business === position.plan.business && !resolvedIssues.has(r.id)
			)
		)
			return yield* Effect.fail(
				new Refusal({
					code: "ReceiptReconciliation",
					message: "Resolve the recorded bookkeeping issue before authorizing more contributions"
				})
			)
		const annual = yield* required(
			position.annual,
			"Refresh the retirement limits and owner attestations for this year"
		)
		const election = yield* required(position.election, "Record the current signed election document")
		if (
			annual.otherPlans ||
			annual.outsideAssets ||
			annual.valid.start > day ||
			annual.valid.end <= day ||
			election.signedOn > day
		)
			return yield* Effect.fail(
				new Refusal({
					code: "RetirementInputs",
					message: "The scoped current-year inputs do not authorize this contribution"
				})
			)
		const additions =
			minimum(annual.additionsLimit, annual.compensationCap, position.compensation + newCompensation) -
			annual.outsideAdditions -
			position.roth -
			position.afterTax
		const target = yield* required(
			source === "EmployeeAfterTax" ? position.remainingAfterTaxTarget : position.remainingRothTarget,
			"The signed election must explicitly supply this source"
		)
		const permitted =
			source === "EmployeeAfterTax"
				? minimum(target, additions)
				: minimum(target, additions, annual.deferralLimit - annual.outsideDeferrals - position.roth)
		if (amount > permitted || amount <= 0n)
			return yield* Effect.fail(
				new Refusal({
					code: "ContributionCapacity",
					message: `${permitted} cents permitted by the current election, compensation, and shared annual limits`
				})
			)
		if (source === "EmployeeAfterTax") {
			const done = new Set((yield* relationRows(snapshot, S.RetirementSetupResolution)).map((r) => r.setup))
			if ((yield* relationRows(snapshot, S.RetirementSetup)).some((r) => r.plan === plan && !done.has(r.id)))
				return yield* Effect.fail(
					new Refusal({
						code: "RetirementSetup",
						message: "Complete the recorded plan setup before authorizing new after-tax funding"
					})
				)
		}
		return position
	})

export const distributionPosition = (snapshot: Snapshot, business: Uuid, year: number) =>
	Effect.gen(function* () {
		const span = periodSpan(year, "Year")
		const distributions = (yield* relationRows(snapshot, S.OwnerDistribution)).filter(
			(r) => r.business === business && r.paidOn >= span.start && r.paidOn < span.end
		)
		const returns = (yield* relationRows(snapshot, S.DistributionReturn)).filter(
			(r) => r.business === business && r.paidOn >= span.start && r.paidOn < span.end
		)
		const allocated = new Set(distributions.map((r) => r.allocation))
		const funding = (yield* relationRows(snapshot, S.ContributionFunding)).filter((r) =>
			allocated.has(r.allocation)
		)
		const facts = { distributions, returns, funding }
		const digest = fingerprint(
			Object.fromEntries(
				Object.entries(facts).map(([k, v]) => [k, [...v].sort((a, b) => json(a).localeCompare(json(b)))])
			)
		)
		const reviews = (yield* relationRows(snapshot, S.DistributionReview)).filter(
			(r) => r.business === business && r.year === BigInt(year)
		)
		return {
			...facts,
			year,
			digest,
			distributed: sum(distributions),
			returned: sum(returns),
			net: sum(distributions) - sum(returns),
			afterTaxFunded: sum(funding),
			reviewed: reviews.some((r) => r.digest === digest),
			reviews
		}
	})

export const retirementActivity = (snapshot: Snapshot, plan: Uuid, year: number) =>
	Effect.gen(function* () {
		const position = yield* retirementPosition(snapshot, plan, year)
		const span = periodSpan(year, "Year")
		const receipts = (yield* relationRows(snapshot, S.PlanReceipt)).filter(
			(r) => r.plan === plan && r.year === BigInt(year)
		)
		const conversions = (yield* relationRows(snapshot, S.RothConversion)).filter(
			(r) => r.plan === plan && r.convertedOn >= span.start && r.convertedOn < span.end
		)
		const contributionIds = new Set(position.contributions.map((r) => r.id)),
			conversionIds = new Set(conversions.map((r) => r.id)),
			receiptIds = new Set(receipts.map((r) => r.id))
		return {
			...position,
			receipts,
			receiptDates: (yield* relationRows(snapshot, S.PlanReceiptDate)).filter((r) =>
				receiptIds.has(r.receipt)
			),
			reportedConversions: (yield* relationRows(snapshot, S.ReportedReceiptConversion)).filter((r) =>
				receiptIds.has(r.receipt)
			),
			conversions,
			funding: (yield* relationRows(snapshot, S.ContributionFunding)).filter((r) =>
				contributionIds.has(r.contribution)
			),
			receiptAllocations: (yield* relationRows(snapshot, S.ReceiptAllocation)).filter(
				(r) => contributionIds.has(r.contribution) || receiptIds.has(r.receipt)
			),
			conversionReceipts: (yield* relationRows(snapshot, S.ConversionReceipt)).filter(
				(r) => conversionIds.has(r.conversion) || receiptIds.has(r.receipt)
			),
			suppliedTax: (yield* relationRows(snapshot, S.SuppliedConversionTax)).filter((r) =>
				conversionIds.has(r.conversion)
			),
			suppliedReports: (yield* relationRows(snapshot, S.RetirementReport)).filter(
				(r) => r.plan === plan && r.year === BigInt(year)
			)
		}
	})

import { commandFields, Day, Id, inputField, inputFields, Year } from "./schema/input.ts"

const AmountLink = Schema.Struct({ id: Id, ...inputFields(S.ReceiptAllocation, ["amount"]) })
const ConversionDetails = Schema.Struct(
	inputFields(S.RothConversion, ["fromAccount", "toAccount", "convertedOn", "amount"], { convertedOn: Day })
)
const Operation = Schema.Union([
	Schema.Struct({
		kind: Schema.Literal("AllocateReceipt"),
		...inputFields(S.ReceiptAllocation, ["receipt"]),
		allocations: Schema.Array(AmountLink)
	}),
	Schema.Struct({
		kind: Schema.Literal("SuppliedReport"),
		...inputFields(S.RetirementReport, ["plan", "year", "artifact", "supplied"], { year: Year })
	}),
	Schema.Struct({
		kind: Schema.Literal("ConfirmReportedConversion"),
		...inputFields(S.ReportedReceiptConversion, ["receipt", "report"])
	}),
	Schema.Struct({
		kind: Schema.Literal("CancelAuthorization"),
		...inputFields(S.ContributionCancellation, ["contribution"])
	}),
	Schema.Struct({
		kind: Schema.Literal("Plan"),
		...inputFields(S.RetirementPlan, ["employee", "name", "ein"])
	}),
	Schema.Struct({
		kind: Schema.Literal("Account"),
		...inputFields(S.PlanAccount, ["plan", "provider", "reference"]),
		accountKind: inputField(S.PlanAccount.fields.kind)
	}),
	Schema.Struct({
		kind: Schema.Literal("Annual"),
		...inputFields(
			S.RetirementAnnual,
			[
				"plan",
				"year",
				"deferralLimit",
				"additionsLimit",
				"compensationCap",
				"outsideDeferrals",
				"outsideAdditions",
				"otherPlans",
				"outsideAssets"
			],
			{ year: Year }
		)
	}),
	Schema.Struct({
		kind: Schema.Literal("BankMovement"),
		...inputFields(S.BankMovement, ["direction", "paidOn", "amount"], { paidOn: Day }),
		...inputFields(S.MercuryTransaction, ["reference"])
	}),
	Schema.Struct({
		kind: Schema.Literal("Distribution"),
		...inputFields(S.CashAllocation, ["movement", "amount"])
	}),
	Schema.Struct({
		kind: Schema.Literal("DistributionReturn"),
		...inputFields(S.DistributionReturn, ["distribution", "amount"]),
		...inputFields(S.CashAllocation, ["movement"])
	}),
	Schema.Struct({
		kind: Schema.Literal("DistributionReview"),
		...inputFields(S.DistributionReview, ["year"], { year: Year })
	}),
	Schema.Struct({
		kind: Schema.Literal("PayrollCash"),
		...inputFields(S.PayrollTransaction, ["movement", "wage"]),
		...inputFields(S.CashAllocation, ["amount"])
	}),
	Schema.Struct({
		kind: Schema.Literal("Contribution"),
		...inputFields(S.RetirementContribution, ["plan", "year", "source", "amount"], {
			year: Year,
			source: Schema.Literal("EmployeeRothDeferral")
		}),
		...inputFields(S.ContributionDeduction, ["wage"])
	}),
	Schema.Struct({
		kind: Schema.Literal("Contribution"),
		...inputFields(S.RetirementContribution, ["plan", "year", "source", "amount"], {
			year: Year,
			source: Schema.Literal("EmployeeAfterTax")
		})
	}),
	Schema.Struct({
		kind: Schema.Literal("AuthorizeAfterTax"),
		...inputFields(S.RetirementContribution, ["plan", "amount"])
	}),
	Schema.Struct({
		kind: Schema.Literal("FundContribution"),
		...inputFields(S.ContributionFunding, ["contribution", "amount"]),
		...inputFields(S.CashAllocation, ["movement"]),
		distribution: Schema.optional(Id)
	}),
	Schema.Struct({
		kind: Schema.Literal("ProviderReceipt"),
		...inputFields(S.ProviderOperation, ["plan", "provider", "reference"]),
		...inputFields(S.PlanReceipt, ["account", "year", "source", "amount"], { year: Year }),
		receivedOn: Schema.optional(Day),
		allocations: Schema.Array(AmountLink),
		conversion: Schema.optional(
			Schema.Struct({ ...ConversionDetails.fields, principal: inputField(S.ConversionReceipt.fields.amount) })
		)
	}),
	Schema.Struct({
		kind: Schema.Literal("Conversion"),
		...inputFields(S.ProviderOperation, ["plan", "provider", "reference"]),
		...ConversionDetails.fields,
		receipts: Schema.Array(AmountLink)
	}),
	Schema.Struct({
		kind: Schema.Literal("SuppliedTax"),
		...inputFields(S.SuppliedConversionTax, ["conversion", "field", "amount"], {
			field: Schema.Literals(["Basis", "Taxable"])
		})
	}),
	Schema.Struct({
		kind: Schema.Literal("Balance"),
		...inputFields(S.PlanBalance, ["account", "asOf", "amount"], { asOf: Day })
	}),
	Schema.Struct({
		kind: Schema.Literal("ResolveSetup"),
		...inputFields(S.RetirementSetupResolution, ["setup"])
	}),
	Schema.Struct({ kind: Schema.Literal("ResolveIssue"), ...inputFields(S.BookkeepingResolution, ["issue"]) })
])
export const BookkeepingInput = Schema.Struct({
	...commandFields,
	evidence: Nonblank,
	operation: Operation
})

/** Records supplied facts. Authorization is a separate closed operation; actual
 * excess or wrong-source history remains observable and surfaces in the register. */
export const recordBookkeeping = (payload: unknown) =>
	Effect.gen(function* () {
		const input = parseStrict(BookkeepingInput, payload),
			business = input.business
		return yield* businessCommand({
			request: input.request,
			business,
			action: "bookkeeping record",
			input: payload,
			plan: ({ snapshot, draft, recordingDay, recordedAt }) =>
				Effect.gen(function* () {
					const op = input.operation,
						evidence = input.evidence
					const plans = (yield* relationRows(snapshot, S.RetirementPlan)).filter(
						(r) => r.business === business
					)
					const ownPlan = (id: string) =>
						required(
							plans.find((r) => r.id === id),
							"Select this business's retirement plan"
						)
					const movements = (yield* relationRows(snapshot, S.BankMovement)).filter(
						(r) => r.business === business
					)
					const ownMovement = (id: string) =>
						required(
							movements.find((r) => r.id === id),
							"Record this business's bank movement first"
						)
					const contributions = (yield* relationRows(snapshot, S.RetirementContribution)).filter((r) =>
						plans.some((p) => p.id === r.plan)
					)
					const allocations = yield* relationRows(snapshot, S.CashAllocation)
					const accounts = yield* relationRows(snapshot, S.PlanAccount)
					const ownAccount = (id: string) =>
						required(
							accounts.find((r) => r.id === id && plans.some((p) => p.id === r.plan)),
							"Select this plan's account"
						)
					const actualDay = (value: UnixEpochDay) => {
						if (value > recordingDay)
							throw new Refusal({
								code: "FutureObservation",
								message: "Record the actual date after the event"
							})
						return value
					}
					const id = yield* mintId
					const allocate = (
						movement: Uuid,
						purpose: (typeof S.CashPurpose.handles)[number],
						amount: bigint,
						allocation: Uuid
					) =>
						draft.insert(S.CashAllocation, [
							{ id: allocation, movement, business, purpose, amount, evidence }
						])
					const operation = (plan: Uuid, provider: string, reference: string) =>
						Effect.gen(function* () {
							const old = (yield* relationRows(snapshot, S.ProviderOperation)).find(
								(r) => r.plan === plan && r.provider === provider && r.reference === reference
							)
							if (old) return old.id
							const operationId = yield* mintId
							yield* draft.insert(S.ProviderOperation, [
								{ id: operationId, plan, provider, reference, evidence, recordedAt }
							])
							return operationId
						})
					const conversion = (
						plan: Uuid,
						operationId: Uuid,
						details: typeof ConversionDetails.Type,
						links: readonly (typeof AmountLink.Type)[]
					) =>
						Effect.gen(function* () {
							const from = yield* ownAccount(details.fromAccount),
								to = yield* ownAccount(details.toAccount)
							if (from.plan !== plan || to.plan !== plan || from.kind !== "AfterTax" || to.kind !== "Roth")
								throw new Refusal({
									code: "ConversionRoute",
									message: "The active conversion route is this plan's after-tax account to Roth"
								})
							const convertedOn = actualDay(details.convertedOn),
								conversionId = yield* mintId
							if ((yield* relationRows(snapshot, S.RothConversion)).some((r) => r.operation === operationId))
								throw new Refusal({
									code: "DuplicateConversion",
									message: "This provider operation already has its conversion"
								})
							yield* draft.insert(S.RothConversion, [
								{
									id: conversionId,
									plan,
									operation: operationId,
									fromAccount: from.id,
									toAccount: to.id,
									convertedOn,
									amount: positive(details.amount),
									evidence,
									recordedAt
								}
							])
							yield* draft.insert(
								S.ConversionReceipt,
								links.map((r) => ({
									conversion: conversionId,
									receipt: entityId(r.id),
									plan,
									amount: positive(r.amount)
								}))
							)
							return conversionId
						})
					switch (op.kind) {
						case "AllocateReceipt": {
							const receipt = yield* required(
								(yield* relationRows(snapshot, S.PlanReceipt)).find(
									(r) => r.id === op.receipt && plans.some((p) => p.id === r.plan)
								),
								"Select this plan's receipt"
							)
							yield* draft.insert(
								S.ReceiptAllocation,
								op.allocations.map((r) => ({
									receipt: receipt.id,
									contribution: entityId(r.id),
									plan: receipt.plan,
									amount: positive(r.amount)
								}))
							)
							break
						}
						case "SuppliedReport": {
							const plan = yield* ownPlan(op.plan)
							yield* draft.insert(S.RetirementReport, [
								{
									id,
									plan: plan.id,
									year: op.year,
									artifact: op.artifact,
									supplied: op.supplied,
									evidence,
									recordedAt
								}
							])
							break
						}
						case "ConfirmReportedConversion": {
							const receipt = yield* required(
								(yield* relationRows(snapshot, S.PlanReceipt)).find(
									(r) => r.id === op.receipt && plans.some((p) => p.id === r.plan)
								),
								"Select this plan's receipt"
							)
							yield* draft.insert(S.ReportedReceiptConversion, [
								{ receipt: receipt.id, report: op.report, plan: receipt.plan, evidence, recordedAt }
							])
							break
						}
						case "CancelAuthorization": {
							const contribution = yield* required(
								contributions.find((r) => r.id === op.contribution && r.origin === "Authorized"),
								"Select an unspent authorization"
							)
							yield* draft.insert(S.ContributionCancellation, [
								{ contribution: contribution.id, evidence, recordedAt }
							])
							break
						}

						case "Plan": {
							const employee = yield* required(
								(yield* relationRows(snapshot, S.Employee)).find(
									(r) => r.id === op.employee && r.business === business
								),
								"Select the sole owner employee"
							)
							yield* draft.insert(S.Owner, [{ business, employee: employee.id, evidence }])
							yield* draft.insert(S.RetirementPlan, [
								{ id, business, employee: employee.id, name: op.name, ein: op.ein, evidence, recordedAt }
							])
							break
						}
						case "Account": {
							const plan = yield* ownPlan(op.plan)
							yield* draft.insert(S.PlanAccount, [
								{
									id,
									plan: plan.id,
									kind: op.accountKind,
									provider: op.provider,
									reference: op.reference,
									evidence
								}
							])
							break
						}
						case "Annual": {
							const plan = yield* ownPlan(op.plan)
							yield* draft.insert(S.RetirementAnnual, [
								{
									id,
									plan: plan.id,
									employee: plan.employee,
									year: op.year,
									valid: periodSpan(Number(op.year), "Year"),
									deferralLimit: op.deferralLimit,
									additionsLimit: op.additionsLimit,
									compensationCap: op.compensationCap,
									outsideDeferrals: op.outsideDeferrals,
									outsideAdditions: op.outsideAdditions,
									otherPlans: op.otherPlans,
									outsideAssets: op.outsideAssets,
									evidence,
									recordedAt
								}
							])
							break
						}
						case "BankMovement": {
							const old = (yield* relationRows(snapshot, S.MercuryTransaction)).find(
								(r) => r.reference === op.reference
							)
							if (old) {
								const movement = yield* ownMovement(old.movement)
								if (
									movement.amount === positive(op.amount) &&
									movement.paidOn === actualDay(op.paidOn) &&
									movement.direction === op.direction
								)
									return { id: movement.id, kind: op.kind }
								yield* draft.insert(S.BookkeepingIssue, [
									{
										id,
										business,
										detail: json({
											reason: "Conflicting bank observation",
											existing: movement.id,
											operation: op
										}),
										evidence,
										recordedAt
									}
								])
								return { kind: "ReconciliationRequired", issue: id }
							}
							yield* draft.insert(S.BankMovement, [
								{
									id,
									business,
									direction: op.direction,
									paidOn: actualDay(op.paidOn),
									amount: positive(op.amount),
									evidence,
									recordedAt
								}
							])
							yield* draft.insert(S.MercuryTransaction, [{ movement: id, reference: op.reference }])
							yield* draft.insert(S.BankReference, [
								{
									movement: id,
									issuer: "Mercury",
									scope: business,
									value: op.reference,
									sourceText: evidence
								}
							])
							break
						}
						case "Distribution": {
							const movement = yield* ownMovement(op.movement),
								owner = yield* required(
									(yield* relationRows(snapshot, S.Owner)).find((r) => r.business === business),
									"Record the sole owner"
								),
								amount = positive(op.amount),
								allocation = yield* mintId
							yield* allocate(movement.id, "OwnerDistribution", amount, allocation)
							yield* draft.insert(S.OwnerDistribution, [
								{
									id,
									allocation,
									business,
									owner: owner.employee,
									paidOn: movement.paidOn,
									amount,
									evidence,
									recordedAt
								}
							])
							break
						}
						case "DistributionReturn": {
							const distribution = yield* required(
									(yield* relationRows(snapshot, S.OwnerDistribution)).find(
										(r) => r.id === op.distribution && r.business === business
									),
									"Select the original distribution"
								),
								movement = yield* ownMovement(op.movement),
								amount = positive(op.amount),
								allocation = yield* mintId
							yield* allocate(movement.id, "DistributionReturn", amount, allocation)
							yield* draft.insert(S.DistributionReturn, [
								{
									id,
									distribution: distribution.id,
									allocation,
									business,
									amount,
									paidOn: movement.paidOn,
									evidence,
									recordedAt
								}
							])
							break
						}
						case "DistributionReview": {
							const position = yield* distributionPosition(snapshot, business, Number(op.year))
							yield* draft.insert(S.DistributionReview, [
								{ id, business, year: op.year, digest: position.digest, evidence, recordedAt }
							])
							break
						}
						case "PayrollCash": {
							const movement = yield* ownMovement(op.movement)
							yield* draft.insert(S.PayrollTransaction, [{ wage: op.wage, movement: movement.id, business }])
							yield* allocate(movement.id, "PayrollCash", positive(op.amount), id)
							yield* draft.insert(S.PayrollCashBinding, [{ allocation: id, wage: op.wage, business }])
							break
						}
						case "Contribution": {
							const plan = yield* ownPlan(op.plan),
								amount = positive(op.amount)
							if (op.source === "EmployeeRothDeferral") {
								const deduction = yield* required(
									(yield* relationRows(snapshot, S.Deduction)).find(
										(r) =>
											r.wage === op.wage &&
											r.employee === plan.employee &&
											r.year === op.year &&
											r.kind === "Roth" &&
											r.amount === amount
									),
									"Link the exact existing Roth payroll deduction"
								)
								yield* draft.insert(S.ContributionDeduction, [
									{
										kind: "Roth",
										contribution: id,
										wage: deduction.wage,
										employee: plan.employee,
										year: op.year,
										amount
									}
								])
							}
							yield* draft.insert(S.RetirementContribution, [
								{
									business,
									id,
									plan: plan.id,
									employee: plan.employee,
									year: op.year,
									amount,
									source: op.source,
									origin: "Observed",
									evidence,
									recordedAt
								}
							])
							break
						}
						case "AuthorizeAfterTax": {
							const plan = yield* ownPlan(op.plan),
								amount = positive(op.amount),
								position = yield* admitContribution(
									snapshot,
									plan.id,
									"EmployeeAfterTax",
									amount,
									recordingDay
								)
							const annual = yield* required(position.annual, "Annual inputs required"),
								document = yield* required(position.election, "Election required"),
								year = BigInt(position.year)
							yield* draft.insert(S.RetirementContribution, [
								{
									business,
									id,
									plan: plan.id,
									employee: plan.employee,
									year,
									amount,
									source: "EmployeeAfterTax",
									origin: "Authorized",
									evidence,
									recordedAt
								}
							])
							yield* draft.insert(S.ContributionAuthorization, [
								{
									contribution: id,
									annual: annual.id,
									employee: plan.employee,
									year,
									authorizedOn: civilDayPoint(recordingDay)
								}
							])
							yield* draft.insert(S.ContributionElection, [
								{ contribution: id, document: document.id, employee: plan.employee, year }
							])
							break
						}
						case "FundContribution": {
							const contribution = yield* required(
									contributions.find((r) => r.id === op.contribution),
									"Select the contribution"
								),
								movement = yield* ownMovement(op.movement),
								amount = positive(op.amount)
							let allocation: Uuid
							if (contribution.source === "EmployeeAfterTax") {
								const distribution = yield* required(
									(yield* relationRows(snapshot, S.OwnerDistribution)).find(
										(r) => r.id === op.distribution && r.business === business
									),
									"After-tax funding must reuse its existing distribution"
								)
								const cash = yield* required(
									allocations.find((r) => r.id === distribution.allocation && r.movement === movement.id),
									"The distribution must reference this same bank movement"
								)
								allocation = cash.id
							} else {
								allocation = yield* mintId
								yield* allocate(movement.id, "RothRemittance", amount, allocation)
							}
							yield* draft.insert(S.ContributionFunding, [
								{ contribution: contribution.id, allocation, business, source: contribution.source, amount }
							])
							break
						}
						case "ProviderReceipt": {
							const plan = yield* ownPlan(op.plan),
								account = yield* ownAccount(op.account),
								operationId = yield* operation(plan.id, op.provider, op.reference)
							if (account.plan !== plan.id)
								throw new Refusal({ code: "AccountScope", message: "Select an account in this plan" })
							if ((yield* relationRows(snapshot, S.PlanReceipt)).some((r) => r.operation === operationId))
								throw new Refusal({
									code: "DuplicateReceipt",
									message: "This provider operation already has its receipt"
								})
							yield* draft.insert(S.PlanReceipt, [
								{
									id,
									plan: plan.id,
									operation: operationId,
									account: account.id,
									source: op.source,
									year: op.year,
									observedOn: recordingDay,
									amount: positive(op.amount),
									evidence,
									recordedAt
								}
							])
							yield* draft.insert(
								S.ReceiptAllocation,
								op.allocations.map((r) => ({
									receipt: id,
									contribution: entityId(r.id),
									plan: plan.id,
									amount: positive(r.amount)
								}))
							)
							if (op.receivedOn !== undefined)
								yield* draft.insert(S.PlanReceiptDate, [
									{ receipt: id, day: actualDay(op.receivedOn), evidence }
								])
							if (op.conversion)
								yield* conversion(plan.id, operationId, op.conversion, [
									{ id, amount: op.conversion.principal }
								])
							break
						}
						case "Conversion": {
							const plan = yield* ownPlan(op.plan),
								operationId = yield* operation(plan.id, op.provider, op.reference)
							const converted = yield* conversion(plan.id, operationId, op, op.receipts)
							return { id: converted, kind: op.kind }
						}
						case "SuppliedTax": {
							const converted = yield* required(
								(yield* relationRows(snapshot, S.RothConversion)).find(
									(r) => r.id === op.conversion && plans.some((p) => p.id === r.plan)
								),
								"Select this plan's conversion"
							)
							yield* draft.insert(S.SuppliedConversionTax, [
								{ conversion: converted.id, field: op.field, amount: op.amount, evidence }
							])
							break
						}
						case "Balance": {
							const account = yield* ownAccount(op.account)
							yield* draft.insert(S.PlanBalance, [
								{
									id,
									account: account.id,
									asOf: actualDay(op.asOf),
									amount: op.amount,
									evidence,
									recordedAt
								}
							])
							break
						}
						case "ResolveSetup": {
							const setup = yield* required(
								(yield* relationRows(snapshot, S.RetirementSetup)).find(
									(r) => r.id === op.setup && plans.some((p) => p.id === r.plan)
								),
								"Select this plan's setup item"
							)
							yield* draft.insert(S.RetirementSetupResolution, [{ setup: setup.id, evidence, recordedAt }])
							break
						}
						case "ResolveIssue": {
							const issue = yield* required(
								(yield* relationRows(snapshot, S.BookkeepingIssue)).find(
									(r) => r.id === op.issue && r.business === business
								),
								"Select this business's issue"
							)
							yield* draft.insert(S.BookkeepingResolution, [{ issue: issue.id, evidence, recordedAt }])
							break
						}
					}
					return { id, kind: op.kind }
				})
		})
	})

/** Filing evidence freezes exact events and supplied facts, never calculated tax boxes. */
export const retirementFilingDigest = (snapshot: Snapshot, plan: Uuid, period: IntervalValue) =>
	Effect.gen(function* () {
		const activity = yield* retirementActivity(snapshot, plan, toCalendarDate(epochDay(period.start)).year)
		const {
			receipts,
			receiptDates,
			receiptAllocations,
			conversions,
			conversionReceipts,
			reportedConversions,
			suppliedTax,
			suppliedReports
		} = activity
		return fingerprint({
			receipts,
			receiptDates,
			receiptAllocations,
			conversions,
			conversionReceipts,
			reportedConversions,
			suppliedTax,
			suppliedReports
		})
	})
export const bookkeepingReport = (snapshot: Snapshot, business: Uuid, year: number) =>
	Effect.gen(function* () {
		const plans = (yield* relationRows(snapshot, S.RetirementPlan)).filter((r) => r.business === business)
		const retirement = yield* Effect.forEach(plans, (p) => retirementActivity(snapshot, p.id, year), {
			concurrency: 1
		})
		const span = periodSpan(year, "Year")
		const mercury = yield* relationRows(snapshot, S.MercuryTransaction)
		const allocations = yield* relationRows(snapshot, S.CashAllocation)
		const payroll = yield* relationRows(snapshot, S.PayrollTransaction)
		const distributions = yield* relationRows(snapshot, S.OwnerDistribution)
		const bank = (yield* relationRows(snapshot, S.BankMovement))
			.filter((r) => r.business === business && r.paidOn >= span.start && r.paidOn < span.end)
			.map((movement) => ({
				...movement,
				mercuryReference: mercury.find((r) => r.movement === movement.id)?.reference,
				allocations: allocations.filter((r) => r.movement === movement.id),
				wages: payroll.filter((r) => r.movement === movement.id).map((r) => r.wage),
				distributions: distributions
					.filter((r) => allocations.some((a) => a.id === r.allocation && a.movement === movement.id))
					.map((r) => r.id)
			}))
		return { distributions: yield* distributionPosition(snapshot, business, year), retirement, bank }
	})
