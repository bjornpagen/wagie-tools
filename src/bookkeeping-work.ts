import type { Uuid } from "@bjornpagen/bumbledb"
import { Effect } from "effect"
import { distributionPosition, receiptDiscrepancies, retirementPosition } from "./bookkeeping.ts"
import { epochDay, parseCalendarDate, periodSpan, toCalendarDate, type UnixEpochDay } from "./core/time.ts"
import { relationRows } from "./queries.ts"
import type { Snapshot } from "./runtime.ts"
import * as S from "./schema.ts"
import type { WorkItem } from "./work.ts"

/** Advisory opportunities and conversion follow-ups share the register with
 * required work, but only unresolved withheld Roth funds block payroll. */
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
		const resolved = new Set((yield* relationRows(snapshot, S.RetirementSetupResolution)).map((r) => r.setup))
		for (const setup of yield* relationRows(snapshot, S.RetirementSetup))
			if (plans.some((p) => p.id === setup.plan))
				work.push({
					kind: "Retirement",
					blocks: "RetirementFunding",
					id: setup.id,
					label: setup.detail,
					opensOn: asOf,
					completion: resolved.has(setup.id) ? "Complete" : "Open",
					action: "bookkeeping ResolveSetup",
					evidence: setup.evidence
				})
		for (const plan of plans) {
			const position = yield* retirementPosition(snapshot, plan.id, year)
			if (!position.annual)
				work.push({
					kind: "PolicyRefresh",
					blocks: "RetirementFunding",
					id: `retirement-annual/${plan.id}/${year}`,
					label: "Refresh retirement annual limits and owner attestations",
					opensOn: span.start,
					completion: "Open",
					action: "bookkeeping Annual"
				})
			if (
				position.statutory &&
				(position.statutory.additionsRemaining < 0n || position.statutory.deferralsRemaining < 0n)
			)
				work.push({
					kind: "Retirement",
					blocks: "RetirementFunding",
					id: `retirement-capacity/${plan.id}/${year}`,
					label: "Recorded contributions exceed current supported annual capacity",
					opensOn: span.start,
					completion: "Open",
					action: "report year"
				})
			if (position.remainingAfterTaxTarget !== undefined && position.remainingAfterTaxTarget > 0n)
				work.push({
					kind: "Retirement",
					blocks: "None",
					id: `target/${plan.id}/${year}`,
					label: "Unused current-year after-tax target",
					opensOn: parseCalendarDate(`${year}-12-01`),
					dueOn: epochDay(span.end - 1n),
					completion: "Open",
					amount: position.remainingAfterTaxTarget,
					action: "bookkeeping AuthorizeAfterTax"
				})
			for (const deduction of deductions.filter(
				(r) => r.employee === plan.employee && r.kind === "Roth" && r.amount > 0n
			)) {
				const contribution = contributions.find((r) =>
					deductionLinks.some((l) => l.wage === deduction.wage && l.contribution === r.id)
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
				const funded = funding
					.filter((r) => r.contribution === contribution?.id)
					.reduce((n, r) => n + r.amount, 0n)
				const paidOn = wages.find((r) => r.id === deduction.wage)?.paidOn.start
				if (paidOn !== undefined)
					work.push({
						kind: "Retirement",
						blocks: "Payroll",
						id: `roth-receipt/${deduction.wage}`,
						label: "Withheld Roth awaiting confirmed plan receipt",
						opensOn: epochDay(paidOn),
						completion: received === deduction.amount && funded === deduction.amount ? "Complete" : "Open",
						amount: deduction.amount - received,
						action: "bookkeeping ProviderReceipt"
					})
			}
			for (const contribution of contributions.filter(
				(r) => r.plan === plan.id && r.source === "EmployeeAfterTax"
			)) {
				const matched = allocations.filter(
					(r) =>
						r.contribution === contribution.id &&
						receipts.some(
							(receipt) =>
								receipt.id === r.receipt &&
								receipt.source === contribution.source &&
								receipt.year === contribution.year
						)
				)
				const received = matched.reduce((n, r) => n + r.amount, 0n)
				work.push({
					kind: "Retirement",
					blocks: "None",
					id: `after-tax-receipt/${contribution.id}`,
					label: "After-tax contribution awaiting plan receipt",
					opensOn: periodSpan(Number(contribution.year), "Year").start,
					dueOn: epochDay(periodSpan(Number(contribution.year), "Year").end - 1n),
					completion: received === contribution.amount ? "Complete" : "Open",
					amount: contribution.amount - received,
					action: "bookkeeping ProviderReceipt"
				})
			}
			for (const receipt of receipts.filter((r) => r.plan === plan.id && r.source === "EmployeeAfterTax")) {
				const converted = conversions
					.filter((r) => r.receipt === receipt.id)
					.reduce((n, r) => n + r.amount, 0n)
				work.push({
					kind: "Retirement",
					blocks: "None",
					id: `conversion/${receipt.id}`,
					label: "After-tax receipt awaiting conversion confirmation",
					opensOn: epochDay(receipt.observedOn),
					completion:
						converted === receipt.amount || reported.some((r) => r.receipt === receipt.id)
							? "Complete"
							: "Open",
					amount: receipt.amount - converted,
					action: "bookkeeping Conversion"
				})
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
						work.push({
							kind: "Setup",
							blocks: "Payroll",
							id: `retirement-filing/${plan.id}/${reportingYear}/${form}`,
							label: `Record the ${reportingYear} ${form} filing expectation and reviewed deadline`,
							opensOn: period.end,
							completion: "Open",
							action: "filings expect-retirement"
						})
			}
		const resolvedIssues = new Set(
			(yield* relationRows(snapshot, S.BookkeepingResolution)).map((r) => r.issue)
		)
		for (const issue of (yield* relationRows(snapshot, S.BookkeepingIssue)).filter(
			(r) => r.business === business
		))
			work.push({
				kind: "Reconciliation",
				blocks: "RetirementFunding",
				id: issue.id,
				label: issue.detail,
				opensOn: asOf,
				completion: resolvedIssues.has(issue.id) ? "Complete" : "Open",
				action: "bookkeeping ResolveIssue",
				evidence: issue.evidence
			})
		for (const plan of plans)
			for (const issue of yield* receiptDiscrepancies(snapshot, plan.id))
				work.push({
					kind: "Reconciliation",
					blocks: "RetirementFunding",
					id: `receipt/${issue.receipt.id}`,
					label: issue.detail,
					opensOn: epochDay(issue.receipt.observedOn),
					completion: "Open",
					action: "report year",
					evidence: issue.receipt.evidence
				})

		const distributionYears = new Set(
			(yield* relationRows(snapshot, S.OwnerDistribution))
				.filter((r) => r.business === business)
				.map((r) => toCalendarDate(epochDay(r.paidOn)).year)
		)
		for (const distributionYear of distributionYears) {
			const position = yield* distributionPosition(snapshot, business, distributionYear)
			work.push({
				kind: "DistributionReview",
				blocks: "None",
				id: `distribution-review/${business}/${distributionYear}`,
				label: `${distributionYear} owner-distribution records for annual tax handoff`,
				opensOn: periodSpan(distributionYear, "Year").end,
				completion: position.reviewed ? "Complete" : "Open",
				action: "bookkeeping DistributionReview"
			})
		}
		return work
	})
