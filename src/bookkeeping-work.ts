import type { Uuid } from "@bjornpagen/bumbledb"
import { Effect } from "effect"
import { distributionPosition, receiptDiscrepancies, retirementPosition } from "./bookkeeping.ts"
import { epochDay, parseCalendarDate, periodSpan, toCalendarDate, type UnixEpochDay } from "./core/time.ts"
import { relationRows } from "./queries.ts"
import { questions } from "./questions.ts"
import type { Snapshot } from "./runtime.ts"
import * as S from "./schema.ts"
import { type WorkItem, workItem } from "./work-rules.ts"

/** Retirement work. Withheld Roth blocks payroll only until it has left the
 * business: fully funded by Mercury movements whose sent receipts are attached.
 * Carry's own confirmation is tracked as a reminder and never gates payroll.
 */
export const bookkeepingWork = (snapshot: Snapshot, business: Uuid, asOf: UnixEpochDay) =>
	Effect.gen(function* () {
		const work: WorkItem[] = [],
			year = toCalendarDate(asOf).year,
			span = periodSpan(year, "Year")
		const plans = (yield* relationRows(snapshot, S.RetirementPlan)).filter((r) => r.business === business)
		const cancelled = new Set(
			(yield* relationRows(snapshot, S.ContributionCancellation)).map((r) => r.contribution)
		)
		const funding = yield* relationRows(snapshot, S.ContributionFunding)
		const cashAllocations = yield* relationRows(snapshot, S.CashAllocation)
		const receiptSources = new Set((yield* relationRows(snapshot, S.BankSource)).map((r) => r.movement))
		const contributions = (yield* relationRows(snapshot, S.RetirementContribution)).filter(
				(r) => !cancelled.has(r.id)
			),
			deductionLinks = yield* relationRows(snapshot, S.ContributionDeduction)
		const deductions = yield* relationRows(snapshot, S.Deduction),
			wages = yield* relationRows(snapshot, S.Wage)
		const receipts = yield* relationRows(snapshot, S.PlanReceipt),
			allocations = yield* relationRows(snapshot, S.ReceiptAllocation),
			conversions = yield* relationRows(snapshot, S.ConversionReceipt)
		const reported = yield* relationRows(snapshot, S.ReportedReceiptConversion)
		for (const question of (yield* questions(snapshot, business)).filter(
			(q) => q.kind === "PlanSetup" || q.kind === "Bookkeeping"
		))
			work.push(
				workItem({
					rule: question.kind === "PlanSetup" ? "plan-setup-question" : "bookkeeping-question",
					subject: question.id,
					label: question.detail,
					opensOn: asOf,
					complete: question.answer !== undefined,
					evidence: question.evidence,
					next: { op: "question.answer", input: { question: question.id } }
				})
			)
		for (const plan of plans) {
			const position = yield* retirementPosition(snapshot, plan.id, year)
			if (!position.annual)
				work.push(
					workItem({
						rule: "retirement-annual",
						subject: `${plan.id}/${year}`,
						label: `Record the ${year} retirement limits and owner attestations`,
						opensOn: span.start,
						complete: false,
						next: { op: "retirement.annual", input: { plan: plan.id, year } }
					})
				)
			if (
				position.statutory &&
				(position.statutory.additionsRemaining < 0n || position.statutory.deferralsRemaining < 0n)
			)
				work.push(
					workItem({
						rule: "retirement-over-capacity",
						subject: `${plan.id}/${year}`,
						label: "Recorded contributions exceed current supported annual capacity",
						opensOn: span.start,
						complete: false,
						next: { op: "report", input: { year } }
					})
				)
			if (position.remainingAfterTaxTarget !== undefined && position.remainingAfterTaxTarget > 0n)
				work.push(
					workItem({
						rule: "after-tax-target",
						subject: `${plan.id}/${year}`,
						label: "Unused current-year after-tax target",
						opensOn: parseCalendarDate(`${year}-12-01`),
						dueOn: epochDay(span.end - 1n),
						complete: false,
						amount: position.remainingAfterTaxTarget,
						next: { op: "retirement.authorize-after-tax", input: { plan: plan.id } }
					})
				)
			for (const deduction of deductions.filter(
				(r) => r.employee === plan.employee && r.kind === "Roth" && r.amount > 0n
			)) {
				const paidOn = wages.find((r) => r.id === deduction.wage)?.paidOn.start
				if (paidOn === undefined) continue
				const contribution = contributions.find((r) =>
					deductionLinks.some((l) => l.wage === deduction.wage && l.contribution === r.id)
				)
				const fundedBy = funding.filter((r) => r.contribution === contribution?.id)
				const funded = fundedBy.reduce((n, r) => n + r.amount, 0n)
				const sent = fundedBy.every((r) => {
					const movement = cashAllocations.find((a) => a.id === r.allocation)?.movement
					return movement !== undefined && receiptSources.has(movement)
				})
				work.push(
					workItem({
						rule: "roth-remittance",
						subject: deduction.wage,
						label:
							funded === deduction.amount && !sent
								? "Attach the Mercury receipt for the withheld Roth wire"
								: "Send withheld Roth to the plan",
						opensOn: epochDay(paidOn),
						complete: funded === deduction.amount && sent,
						amount: deduction.amount - funded,
						next:
							funded === deduction.amount
								? { op: "artifact.attach-bank", input: {} }
								: { op: "retirement.fund", input: { contribution: contribution?.id } }
					})
				)
				const received = allocations
					.filter(
						(r) =>
							r.contribution === contribution?.id &&
							receipts.some(
								(receipt) =>
									receipt.id === r.receipt &&
									receipt.source === "EmployeeRothDeferral" &&
									receipt.year === deduction.year
							)
					)
					.reduce((n, r) => n + r.amount, 0n)
				work.push(
					workItem({
						rule: "roth-plan-receipt",
						subject: deduction.wage,
						label: "Carry has not yet confirmed this withheld Roth",
						opensOn: epochDay(paidOn),
						complete: received === deduction.amount,
						amount: deduction.amount - received,
						next: {
							op: "retirement.receipt",
							input: { plan: plan.id, source: "EmployeeRothDeferral", year: Number(deduction.year) }
						}
					})
				)
			}
			for (const contribution of contributions.filter(
				(r) => r.plan === plan.id && r.source === "EmployeeAfterTax"
			)) {
				const received = allocations
					.filter(
						(r) =>
							r.contribution === contribution.id &&
							receipts.some(
								(receipt) =>
									receipt.id === r.receipt &&
									receipt.source === contribution.source &&
									receipt.year === contribution.year
							)
					)
					.reduce((n, r) => n + r.amount, 0n)
				work.push(
					workItem({
						rule: "after-tax-plan-receipt",
						subject: contribution.id,
						label: "After-tax contribution awaiting plan receipt",
						opensOn: periodSpan(Number(contribution.year), "Year").start,
						dueOn: epochDay(periodSpan(Number(contribution.year), "Year").end - 1n),
						complete: received === contribution.amount,
						amount: contribution.amount - received,
						next: {
							op: "retirement.receipt",
							input: { plan: plan.id, source: "EmployeeAfterTax", year: Number(contribution.year) }
						}
					})
				)
			}
			for (const receipt of receipts.filter((r) => r.plan === plan.id && r.source === "EmployeeAfterTax")) {
				const converted = conversions
					.filter((r) => r.receipt === receipt.id)
					.reduce((n, r) => n + r.amount, 0n)
				work.push(
					workItem({
						rule: "after-tax-conversion",
						subject: receipt.id,
						label: "After-tax receipt awaiting conversion confirmation",
						opensOn: epochDay(receipt.observedOn),
						complete: converted === receipt.amount || reported.some((r) => r.receipt === receipt.id),
						amount: receipt.amount - converted,
						next: { op: "retirement.conversion", input: { plan: plan.id } }
					})
				)
			}
		}
		const converted = yield* relationRows(snapshot, S.RothConversion),
			subjects = yield* relationRows(snapshot, S.PlanSubject),
			filings = yield* relationRows(snapshot, S.Filing)
		for (const plan of plans)
			for (const reportingYear of new Set(
				converted.filter((r) => r.plan === plan.id).map((r) => toCalendarDate(epochDay(r.convertedOn)).year)
			)) {
				const period = periodSpan(reportingYear, "Year"),
					subject = subjects.find((r) => r.plan === plan.id)?.subject
				for (const form of ["F1099RIRS", "F1099RRecipient"] as const)
					if (
						!filings.some((r) => r.subject === subject && r.form === form && r.period.start === period.start)
					)
						work.push(
							workItem({
								rule: "retirement-filing-expectation",
								subject: `${plan.id}/${reportingYear}/${form}`,
								label: `Record the ${reportingYear} ${form} filing expectation and reviewed deadline`,
								opensOn: period.end,
								complete: false,
								next: {
									op: "filings.expect-retirement",
									input: { plan: plan.id, form, year: reportingYear }
								}
							})
						)
			}
		for (const plan of plans)
			for (const issue of yield* receiptDiscrepancies(snapshot, plan.id))
				work.push(
					workItem({
						rule: "receipt-discrepancy",
						subject: issue.receipt.id,
						label: issue.detail,
						opensOn: epochDay(issue.receipt.observedOn),
						complete: false,
						evidence: issue.receipt.evidence,
						next: { op: "retirement.allocate-receipt", input: { receipt: issue.receipt.id } }
					})
				)

		const distributionYears = new Set(
			(yield* relationRows(snapshot, S.OwnerDistribution))
				.filter((r) => r.business === business)
				.map((r) => toCalendarDate(epochDay(r.paidOn)).year)
		)
		for (const distributionYear of distributionYears) {
			const position = yield* distributionPosition(snapshot, business, distributionYear)
			work.push(
				workItem({
					rule: "distribution-review",
					subject: `${business}/${distributionYear}`,
					label: `${distributionYear} owner-distribution records for annual tax handoff`,
					opensOn: periodSpan(distributionYear, "Year").end,
					complete: position.reviewed,
					next: { op: "bank.distribution-review", input: { year: distributionYear } }
				})
			)
		}
		return work
	})
