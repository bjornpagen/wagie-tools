import type { Fact, IntervalValue, Uuid } from "@bjornpagen/bumbledb"
import { Effect, Schema } from "effect"
import { businessCommand } from "./commands.ts"
import { formatDollars } from "./core/boundary.ts"
import { civilDayPoint, epochDay, periodSpan, toCalendarDate, type UnixEpochDay } from "./core/time.ts"
import { canonicalJson, entityId, json, mintId, Nonblank, Refusal } from "./core/values.ts"
import { exists, first, relationRows, select } from "./queries.ts"
import { askQuestion, questions } from "./questions.ts"
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
		const receipts = yield* select(snapshot, S.PlanReceipt, { plan })
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
			yield* first(snapshot, S.RetirementPlan, { id: planId }),
			"Select a retirement plan"
		)
		const annual = yield* first(snapshot, S.RetirementAnnual, { plan: plan.id, year: BigInt(year) })
		const wages = yield* select(snapshot, S.Wage, { employee: plan.employee, year: BigInt(year) })
		const deductions = yield* select(snapshot, S.Deduction, {
			employee: plan.employee,
			year: BigInt(year),
			kind: "Roth"
		})
		const cancelled = new Set(
			(yield* relationRows(snapshot, S.ContributionCancellation)).map((r) => r.contribution)
		)
		const contributions = (yield* select(snapshot, S.RetirementContribution, {
			plan: plan.id,
			year: BigInt(year)
		})).filter((r) => !cancelled.has(r.id))
		const roth = sum(deductions)
		const afterTax = sum(contributions.filter((r) => r.source === "EmployeeAfterTax"))
		const compensation = wages.reduce((n, r) => n + r.gross, 0n)
		const superseded = new Set(
			(yield* relationRows(snapshot, S.ElectionDocumentRevision)).map((r) => r.predecessor)
		)
		const election = (yield* select(snapshot, S.ElectionDocument, {
			employee: plan.employee,
			year: BigInt(year)
		})).find((r) => !superseded.has(r.id))
		const elected = yield* relationRows(snapshot, S.ElectionDocumentAmount)
		const rothTarget = elected.find((r) => r.document === election?.id && r.kind === "Roth")?.amount
		const afterTaxTarget = elected.find(
			(r) => r.document === election?.id && r.kind === "OptionalAfterTax"
		)?.amount
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
		const open = (yield* questions(snapshot, position.plan.business)).filter((q) => !q.answer)
		if (open.some((q) => q.kind === "Bookkeeping"))
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
					message: `$${formatDollars(permitted)} permitted by the current election, compensation, and shared annual limits`
				})
			)
		if (source === "EmployeeAfterTax") {
			if (open.some((q) => q.kind === "PlanSetup" && q.plan === plan))
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
		const distributions = (yield* select(snapshot, S.OwnerDistribution, { business })).filter(
			(r) => r.paidOn >= span.start && r.paidOn < span.end
		)
		const returns = (yield* select(snapshot, S.DistributionReturn, { business })).filter(
			(r) => r.paidOn >= span.start && r.paidOn < span.end
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
		const reviews = yield* select(snapshot, S.DistributionReview, { business, year: BigInt(year) })
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
		const receipts = yield* select(snapshot, S.PlanReceipt, { plan, year: BigInt(year) })
		const conversions = (yield* select(snapshot, S.RothConversion, { plan })).filter(
			(r) => r.convertedOn >= span.start && r.convertedOn < span.end
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
			...(yield* suppliedReportsOf(
				yield* select(snapshot, S.RetirementReport, { plan, year: BigInt(year) }),
				(relation, report) => select(snapshot, relation, { report } as Partial<Fact<typeof relation>>)
			))
		}
	})

/** A plan-year's provider reports with their typed figures. */
export type SuppliedReports = {
	suppliedReports: readonly Fact<typeof S.RetirementReport>[]
	reported1099R: readonly Fact<typeof S.Reported1099R>[]
	reported1099RBasis: readonly Fact<typeof S.Reported1099RBasis>[]
	reported1096: readonly Fact<typeof S.Reported1096>[]
}
const suppliedReportsOf = (
	reports: readonly Fact<typeof S.RetirementReport>[],
	armsOf: <R extends typeof S.Reported1099R | typeof S.Reported1099RBasis | typeof S.Reported1096>(
		relation: R,
		report: Uuid
	) => Effect.Effect<readonly Fact<R>[], unknown>
): Effect.Effect<SuppliedReports, unknown> =>
	Effect.gen(function* () {
		const arms = <R extends typeof S.Reported1099R | typeof S.Reported1099RBasis | typeof S.Reported1096>(
			relation: R
		) =>
			Effect.map(
				Effect.forEach(reports, (report) => armsOf(relation, report.id)),
				(found) => found.flat()
			)
		return {
			suppliedReports: reports,
			reported1099R: yield* arms(S.Reported1099R),
			reported1099RBasis: yield* arms(S.Reported1099RBasis),
			reported1096: yield* arms(S.Reported1096)
		}
	})

import { commandFields, Day, Id, inputField, inputFields, money } from "./schema/input.ts"

const AmountLink = Schema.Struct({ id: Id, ...inputFields(S.ReceiptAllocation, ["amount"]) })
const ConversionDetails = Schema.Struct(
	inputFields(S.RothConversion, ["fromAccount", "toAccount", "convertedOn", "amount"])
)
/** Each bookkeeping operation is one closed arm, keyed by its kind. */
export const operations = {
	AllocateReceipt: Schema.Struct({
		kind: Schema.Literal("AllocateReceipt"),
		...inputFields(S.ReceiptAllocation, ["receipt"]),
		allocations: Schema.Array(AmountLink)
	}),
	SuppliedReport: Schema.Struct({
		kind: Schema.Literal("SuppliedReport"),
		...inputFields(S.RetirementReport, ["plan", "year", "artifact"]),
		report: Schema.Union([
			Schema.Struct({
				form: Schema.Literal("F1099R"),
				...inputFields(S.Reported1099R, ["account", "distributionCode", "gross", "taxable"]),
				basis: Schema.optional(money(S.Reported1099RBasis.fields.amount))
			}),
			Schema.Struct({
				form: Schema.Literal("F1096"),
				...inputFields(S.Reported1096, ["forms", "gross"])
			})
		])
	}),
	ConfirmReportedConversion: Schema.Struct({
		kind: Schema.Literal("ConfirmReportedConversion"),
		...inputFields(S.ReportedReceiptConversion, ["receipt", "report"])
	}),
	CancelAuthorization: Schema.Struct({
		kind: Schema.Literal("CancelAuthorization"),
		...inputFields(S.ContributionCancellation, ["contribution"])
	}),
	Plan: Schema.Struct({
		kind: Schema.Literal("Plan"),
		...inputFields(S.RetirementPlan, ["employee", "name", "ein"])
	}),
	Account: Schema.Struct({
		kind: Schema.Literal("Account"),
		...inputFields(S.PlanAccount, ["plan", "provider", "reference"]),
		accountKind: inputField(S.PlanAccount.fields.kind)
	}),
	Annual: Schema.Struct({
		kind: Schema.Literal("Annual"),
		...inputFields(S.RetirementAnnual, [
			"plan",
			"year",
			"deferralLimit",
			"additionsLimit",
			"compensationCap",
			"outsideDeferrals",
			"outsideAdditions",
			"otherPlans",
			"outsideAssets"
		])
	}),
	BankMovement: Schema.Struct({
		kind: Schema.Literal("BankMovement"),
		...inputFields(S.BankMovement, ["direction", "paidOn", "amount"]),
		...inputFields(S.MercuryTransaction, ["reference"])
	}),
	Distribution: Schema.Struct({
		kind: Schema.Literal("Distribution"),
		...inputFields(S.CashAllocation, ["movement", "amount"])
	}),
	DistributionReturn: Schema.Struct({
		kind: Schema.Literal("DistributionReturn"),
		...inputFields(S.DistributionReturn, ["distribution", "amount"]),
		...inputFields(S.CashAllocation, ["movement"])
	}),
	DistributionReview: Schema.Struct({
		kind: Schema.Literal("DistributionReview"),
		...inputFields(S.DistributionReview, ["year"])
	}),
	PayrollCash: Schema.Struct({
		kind: Schema.Literal("PayrollCash"),
		...inputFields(S.PayrollTransaction, ["movement", "wage"]),
		...inputFields(S.CashAllocation, ["amount"])
	}),
	Contribution: Schema.Union([
		Schema.Struct({
			kind: Schema.Literal("Contribution"),
			...inputFields(S.RetirementContribution, ["plan", "year", "source", "amount"], {
				source: Schema.Literal("EmployeeRothDeferral")
			}),
			...inputFields(S.ContributionDeduction, ["wage"])
		}),
		Schema.Struct({
			kind: Schema.Literal("Contribution"),
			...inputFields(S.RetirementContribution, ["plan", "year", "source", "amount"], {
				source: Schema.Literal("EmployeeAfterTax")
			})
		})
	]),
	AuthorizeAfterTax: Schema.Struct({
		kind: Schema.Literal("AuthorizeAfterTax"),
		...inputFields(S.RetirementContribution, ["plan", "amount"])
	}),
	FundContribution: Schema.Struct({
		kind: Schema.Literal("FundContribution"),
		...inputFields(S.ContributionFunding, ["contribution", "amount"]),
		...inputFields(S.CashAllocation, ["movement"]),
		distribution: Schema.optional(Id)
	}),
	ProviderReceipt: Schema.Struct({
		kind: Schema.Literal("ProviderReceipt"),
		...inputFields(S.ProviderOperation, ["plan", "provider", "reference"]),
		...inputFields(S.PlanReceipt, ["account", "year", "source", "amount"]),
		receivedOn: Schema.optional(Day),
		allocations: Schema.Array(AmountLink),
		conversion: Schema.optional(
			Schema.Struct({ ...ConversionDetails.fields, principal: money(S.ConversionReceipt.fields.amount) })
		)
	}),
	Conversion: Schema.Struct({
		kind: Schema.Literal("Conversion"),
		...inputFields(S.ProviderOperation, ["plan", "provider", "reference"]),
		...ConversionDetails.fields,
		receipts: Schema.Array(AmountLink)
	}),
	SuppliedTax: Schema.Struct({
		kind: Schema.Literal("SuppliedTax"),
		...inputFields(S.SuppliedConversionTax, ["conversion", "field", "amount"])
	}),
	Balance: Schema.Struct({
		kind: Schema.Literal("Balance"),
		...inputFields(S.PlanBalance, ["account", "asOf", "amount"])
	})
}
const Operation = Schema.Union(Object.values(operations))
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
			plan: ({ snapshot, draft, recordingDay, note }) =>
				Effect.gen(function* () {
					const op = input.operation,
						evidence = yield* note(input.evidence)
					const plans = yield* select(snapshot, S.RetirementPlan, { business })
					const ownPlan = (id: string) =>
						required(
							plans.find((r) => r.id === id),
							"Select this business's retirement plan"
						)
					const movements = yield* select(snapshot, S.BankMovement, { business })
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
					const actualDay = (value: bigint): UnixEpochDay => {
						if (value > recordingDay)
							throw new Refusal({
								code: "FutureObservation",
								message: "Record the actual date after the event"
							})
						return epochDay(value)
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
							const old = yield* first(snapshot, S.ProviderOperation, { plan, provider, reference })
							if (old) return old.id
							const operationId = yield* mintId
							yield* draft.insert(S.ProviderOperation, [
								{ id: operationId, plan, provider, reference, evidence }
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
							if (yield* exists(snapshot, S.RothConversion, { operation: operationId }))
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
									evidence
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
								(yield* select(snapshot, S.PlanReceipt, { id: op.receipt })).find((r) =>
									plans.some((p) => p.id === r.plan)
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
							const plan = yield* ownPlan(op.plan),
								report = op.report
							yield* draft.insert(S.RetirementReport, [
								{ id, plan: plan.id, year: op.year, artifact: op.artifact, form: report.form, evidence }
							])
							switch (report.form) {
								case "F1099R": {
									const account = yield* ownAccount(report.account)
									yield* draft.insert(S.Reported1099R, [
										{
											report: id,
											plan: plan.id,
											account: account.id,
											distributionCode: report.distributionCode,
											gross: report.gross,
											taxable: report.taxable
										}
									])
									if (report.basis !== undefined)
										yield* draft.insert(S.Reported1099RBasis, [{ report: id, amount: report.basis }])
									break
								}
								case "F1096":
									yield* draft.insert(S.Reported1096, [
										{ report: id, forms: report.forms, gross: report.gross }
									])
									break
							}
							break
						}
						case "ConfirmReportedConversion": {
							const receipt = yield* required(
								(yield* select(snapshot, S.PlanReceipt, { id: op.receipt })).find((r) =>
									plans.some((p) => p.id === r.plan)
								),
								"Select this plan's receipt"
							)
							yield* draft.insert(S.ReportedReceiptConversion, [
								{ id, receipt: receipt.id, report: op.report, plan: receipt.plan, evidence }
							])
							break
						}
						case "CancelAuthorization": {
							const contribution = yield* required(
								contributions.find((r) => r.id === op.contribution && r.origin === "Authorized"),
								"Select an unspent authorization"
							)
							yield* draft.insert(S.ContributionCancellation, [
								{ id, contribution: contribution.id, evidence }
							])
							break
						}

						case "Plan": {
							const employee = yield* required(
								yield* first(snapshot, S.Employee, { id: op.employee, business }),
								"Select the sole owner employee"
							)
							yield* draft.insert(S.Owner, [{ business, employee: employee.id, evidence }])
							yield* draft.insert(S.RetirementPlan, [
								{ id, business, employee: employee.id, name: op.name, ein: op.ein, evidence }
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
									evidence
								}
							])
							break
						}
						case "BankMovement": {
							const old = yield* first(snapshot, S.MercuryTransaction, { reference: op.reference })
							if (old) {
								const movement = yield* ownMovement(old.movement)
								if (
									movement.amount === positive(op.amount) &&
									movement.paidOn === actualDay(op.paidOn) &&
									movement.direction === op.direction
								)
									return { id: movement.id, kind: op.kind }
								const issue = yield* askQuestion(
									draft,
									note,
									business,
									{ kind: "Bookkeeping" },
									`Conflicting bank observation of Mercury ${op.reference}: recorded movement ${movement.id} differs from ${json(op)}`,
									input.evidence
								)
								return { kind: "ReconciliationRequired", issue }
							}
							yield* draft.insert(S.BankMovement, [
								{
									id,
									business,
									direction: op.direction,
									paidOn: actualDay(op.paidOn),
									amount: positive(op.amount),
									evidence
								}
							])
							yield* draft.insert(S.MercuryTransaction, [{ movement: id, reference: op.reference }])
							break
						}
						case "Distribution": {
							const movement = yield* ownMovement(op.movement),
								owner = yield* required(
									yield* first(snapshot, S.Owner, { business }),
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
									evidence
								}
							])
							break
						}
						case "DistributionReturn": {
							const distribution = yield* required(
									yield* first(snapshot, S.OwnerDistribution, { id: op.distribution, business }),
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
									evidence
								}
							])
							break
						}
						case "DistributionReview": {
							const position = yield* distributionPosition(snapshot, business, Number(op.year))
							yield* draft.insert(S.DistributionReview, [
								{ id, business, year: op.year, digest: position.digest, evidence }
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
									yield* first(snapshot, S.Deduction, {
										wage: op.wage,
										employee: plan.employee,
										year: op.year,
										kind: "Roth",
										amount
									}),
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
									evidence
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
									evidence
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
									op.distribution === undefined
										? undefined
										: yield* first(snapshot, S.OwnerDistribution, { id: op.distribution, business }),
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
							if (yield* exists(snapshot, S.PlanReceipt, { operation: operationId }))
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
									evidence
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
								(yield* select(snapshot, S.RothConversion, { id: op.conversion })).find((r) =>
									plans.some((p) => p.id === r.plan)
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
									evidence
								}
							])
							break
						}
					}
					return { id, kind: op.kind }
				})
		})
	})

/** The frozen basis of a retirement filing: every event and supplied fact for
 * the plan's year, never a calculated tax box. Rows are printed with sorted
 * keys and sorted, so the digest depends on the facts alone, not on how any
 * caller assembled them. */
export const filingDigestOf = (
	activity: {
		receipts: readonly Fact<typeof S.PlanReceipt>[]
		receiptDates: readonly Fact<typeof S.PlanReceiptDate>[]
		receiptAllocations: readonly Fact<typeof S.ReceiptAllocation>[]
		conversions: readonly Fact<typeof S.RothConversion>[]
		conversionReceipts: readonly Fact<typeof S.ConversionReceipt>[]
		reportedConversions: readonly Fact<typeof S.ReportedReceiptConversion>[]
		suppliedTax: readonly Fact<typeof S.SuppliedConversionTax>[]
	} & SuppliedReports
) => {
	const canonical = <T>(rows: readonly T[]) =>
		rows.map(canonicalJson).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
	return fingerprint({
		receipts: canonical(activity.receipts),
		receiptDates: canonical(activity.receiptDates),
		receiptAllocations: canonical(activity.receiptAllocations),
		conversions: canonical(activity.conversions),
		conversionReceipts: canonical(activity.conversionReceipts),
		reportedConversions: canonical(activity.reportedConversions),
		suppliedTax: canonical(activity.suppliedTax),
		suppliedReports: canonical(activity.suppliedReports),
		reported1099R: canonical(activity.reported1099R),
		reported1099RBasis: canonical(activity.reported1099RBasis),
		reported1096: canonical(activity.reported1096)
	})
}

/** Which rows of a plan's year enter its filing basis; shared with the
 * cutovers, which must re-derive stored digests over migrated rows. */
export const filingActivityOf = (
	plan: Uuid,
	year: number,
	rows: {
		receipts: readonly Fact<typeof S.PlanReceipt>[]
		receiptDates: readonly Fact<typeof S.PlanReceiptDate>[]
		receiptAllocations: readonly Fact<typeof S.ReceiptAllocation>[]
		conversions: readonly Fact<typeof S.RothConversion>[]
		conversionReceipts: readonly Fact<typeof S.ConversionReceipt>[]
		reportedConversions: readonly Fact<typeof S.ReportedReceiptConversion>[]
		suppliedTax: readonly Fact<typeof S.SuppliedConversionTax>[]
		contributions: readonly Fact<typeof S.RetirementContribution>[]
	} & SuppliedReports
) => {
	const span = periodSpan(year, "Year")
	const receipts = rows.receipts.filter((r) => r.plan === plan && r.year === BigInt(year))
	const conversions = rows.conversions.filter(
		(r) => r.plan === plan && r.convertedOn >= span.start && r.convertedOn < span.end
	)
	const contributionIds = new Set(
		rows.contributions.filter((r) => r.plan === plan && r.year === BigInt(year)).map((r) => r.id)
	)
	const suppliedReports = rows.suppliedReports.filter((r) => r.plan === plan && r.year === BigInt(year))
	const conversionIds = new Set(conversions.map((r) => r.id)),
		receiptIds = new Set(receipts.map((r) => r.id)),
		reportIds = new Set(suppliedReports.map((r) => r.id))
	return {
		receipts,
		receiptDates: rows.receiptDates.filter((r) => receiptIds.has(r.receipt)),
		receiptAllocations: rows.receiptAllocations.filter(
			(r) => contributionIds.has(r.contribution) || receiptIds.has(r.receipt)
		),
		conversions,
		conversionReceipts: rows.conversionReceipts.filter(
			(r) => conversionIds.has(r.conversion) || receiptIds.has(r.receipt)
		),
		reportedConversions: rows.reportedConversions.filter((r) => receiptIds.has(r.receipt)),
		suppliedTax: rows.suppliedTax.filter((r) => conversionIds.has(r.conversion)),
		suppliedReports,
		reported1099R: rows.reported1099R.filter((r) => reportIds.has(r.report)),
		reported1099RBasis: rows.reported1099RBasis.filter((r) => reportIds.has(r.report)),
		reported1096: rows.reported1096.filter((r) => reportIds.has(r.report))
	}
}

export const retirementFilingDigest = (snapshot: Snapshot, plan: Uuid, period: IntervalValue) =>
	Effect.gen(function* () {
		const activity = yield* retirementActivity(snapshot, plan, toCalendarDate(epochDay(period.start)).year)
		return filingDigestOf(activity)
	})
export const bookkeepingReport = (snapshot: Snapshot, business: Uuid, year: number) =>
	Effect.gen(function* () {
		const plans = yield* select(snapshot, S.RetirementPlan, { business })
		const retirement = yield* Effect.forEach(plans, (p) => retirementActivity(snapshot, p.id, year), {
			concurrency: 1
		})
		const span = periodSpan(year, "Year")
		const mercury = yield* relationRows(snapshot, S.MercuryTransaction)
		const allocations = yield* relationRows(snapshot, S.CashAllocation)
		const payroll = yield* relationRows(snapshot, S.PayrollTransaction)
		const distributions = yield* relationRows(snapshot, S.OwnerDistribution)
		const bank = (yield* select(snapshot, S.BankMovement, { business }))
			.filter((r) => r.paidOn >= span.start && r.paidOn < span.end)
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
