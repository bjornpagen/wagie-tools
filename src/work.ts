import type { Uuid } from "@bjornpagen/bumbledb"
import { Effect } from "effect"
import { retirementFilingDigest } from "./bookkeeping.ts"
import { bookkeepingWork } from "./bookkeeping-work.ts"
import { epochDay, periodSpan, toCalendarDate, type UnixEpochDay } from "./core/time.ts"
import { Refusal } from "./core/values.ts"
import { depositRegister, entryKey } from "./deposits.ts"
import { inspectDocuments } from "./documents.ts"
import { annualPolicyData, missingAnnualInputs } from "./policy/annual.ts"
import { currentAssessments, currentRevisions, liabilityEntries, relationRows, rows } from "./queries.ts"
import { questions } from "./questions.ts"
import { paymentEquation } from "./reconciliation.ts"
import { employeeTaxPositions, recoveryEquation } from "./recoveries.ts"
import type { Snapshot } from "./runtime.ts"
import { formPolicy } from "./schema/vocabulary.ts"
import * as S from "./schema.ts"
import { type WorkItem, workItem } from "./work-rules.ts"

export type { WorkItem } from "./work-rules.ts"
export type ReadinessIssue = { readonly id: string; readonly kind: string; readonly detail: string }

/** A single authoritative read model. Completion is derived from evidence;
 * there are no writable pending/complete flags and no mutations during reads.
 * Every caller, including the payroll domain command, uses its blockers.
 */
export const workRegister = (snapshot: Snapshot, business: Uuid, asOf: UnixEpochDay) =>
	Effect.gen(function* () {
		// A native snapshot is one serial query session. Keep these reads on
		// that exact state; independent snapshots may run concurrently.
		const data = yield* Effect.all(
			{
				subjects: relationRows(snapshot, S.FilingSubject),
				planSubjects: relationRows(snapshot, S.PlanSubject),
				retirementBases: relationRows(snapshot, S.RetirementFilingBasis),
				formAdjustments: relationRows(snapshot, S.FormAdjustment),
				adjustmentBases: relationRows(snapshot, S.FilingAdjustmentBasis),
				deductions: relationRows(snapshot, S.Deduction),
				recoveries: relationRows(snapshot, S.Recovery),
				assessed: rows(snapshot, currentAssessments, {}),
				employeeSubjects: relationRows(snapshot, S.EmployeeSubject),
				budgets: relationRows(snapshot, S.AnnualBudget),
				commitments: relationRows(snapshot, S.BudgetCommitment),
				assignments: relationRows(snapshot, S.BudgetAssignment),
				bases: relationRows(snapshot, S.FilingBasis),
				corrections: relationRows(snapshot, S.CorrectionFiling),
				revisions: rows(snapshot, currentRevisions, {}),
				filings: relationRows(snapshot, S.Filing),
				versions: relationRows(snapshot, S.FilingVersion),
				submissions: relationRows(snapshot, S.Submission),
				rejections: relationRows(snapshot, S.Rejection),
				deadlines: relationRows(snapshot, S.DeadlineRevision),
				requirements: relationRows(snapshot, S.FilingRequirement),
				ends: relationRows(snapshot, S.RequirementEnd),
				scopes: relationRows(snapshot, S.FilingScope),
				payments: relationRows(snapshot, S.TaxPayment),
				reconciliations: relationRows(snapshot, S.PaymentReconciliation),
				allocations: relationRows(snapshot, S.PaymentAllocation),
				adjustments: relationRows(snapshot, S.PaymentAdjustment),
				dispositions: relationRows(snapshot, S.SignedDisposition),
				amendments: relationRows(snapshot, S.AmendmentLiability),
				employees: relationRows(snapshot, S.Employee),
				elections: relationRows(snapshot, S.Election),
				electionDocuments: relationRows(snapshot, S.ElectionDocument),
				businesses: relationRows(snapshot, S.Business),
				accounts: relationRows(snapshot, S.TaxAccount),
				bindings: relationRows(snapshot, S.PolicyBinding),
				entries: rows(snapshot, liabilityEntries, {})
			},
			{ concurrency: 1 }
		)
		const company = data.businesses.find((row) => row.id === business)
		if (!company)
			return yield* Effect.fail(new Refusal({ code: "BusinessMissing", message: `No business ${business}` }))
		const year = BigInt(toCalendarDate(asOf).year)
		const yearSpan = periodSpan(Number(year), "Year")
		const employees = data.employees.filter((row) => row.business === business)
		const employeeIds = new Set(employees.map((row) => row.id))
		const work: WorkItem[] = []
		const readiness: ReadinessIssue[] = []
		const annual = yield* annualPolicyData(snapshot, business)
		const active = data.bindings.find((row) => row.business === business)
		for (const policyYear of [year, year + 1n]) {
			const valid = periodSpan(Number(policyYear), "Year")
			for (const authority of S.Authority.handles) {
				const approval = annual.approvals.find(
					(row) =>
						row.release === active?.release &&
						row.authority === authority &&
						row.year === policyYear &&
						row.valid.start === valid.start &&
						row.valid.end === valid.end
				)
				const candidate = annual.policies.find(
					(row) => row.authority === authority && row.year === policyYear
				)
				const missing = candidate ? missingAnnualInputs(annual, candidate.id) : ["PublishedAnnualPolicy"]
				work.push(
					workItem({
						rule: "policy-refresh",
						subject: `${authority}/${policyYear}`,
						label: approval
							? `${policyYear} ${authority} payroll policy approved`
							: `${policyYear} ${authority} payroll policy needs refresh${missing.length ? `; missing ${missing.join(", ")}` : ""}`,
						opensOn: valid.start,
						dueOn: valid.start,
						complete: approval !== undefined,
						next: candidate
							? { op: "policy.refresh", input: { annual: candidate.id, release: active?.release } }
							: {
									op: "policy.annual",
									input: { authority, year: Number(policyYear), release: active?.release }
								}
					})
				)
			}
		}
		const setup = (
			rule: Parameters<typeof workItem>[0]["rule"],
			subject: string,
			label: string,
			next: WorkItem["next"]
		) => work.push(workItem({ rule, subject, label, opensOn: asOf, complete: false, next }))
		const rejected = new Set(data.rejections.map((row) => row.submission))
		const currentVersions = new Map<Uuid, (typeof data.versions)[number]>()
		for (const version of data.versions) {
			const previous = currentVersions.get(version.filing)
			if (!previous || previous.sequence < version.sequence) currentVersions.set(version.filing, version)
		}
		const deadlines = new Map<Uuid, (typeof data.deadlines)[number]>()
		for (const deadline of data.deadlines) {
			const previous = deadlines.get(deadline.filing)
			if (!previous || previous.sequence < deadline.sequence) deadlines.set(deadline.filing, deadline)
		}
		const filings = data.filings.filter((row) => row.business === business)
		for (const filing of filings) {
			const version = currentVersions.get(filing.id)
			const completed =
				version !== undefined &&
				data.submissions.some((row) => row.version === version.id && !rejected.has(row.id))
			const employee = data.employeeSubjects.find((row) => row.subject === filing.subject)?.employee
			const plan = data.planSubjects.find((r) => r.subject === filing.subject)?.plan
			const expected = data.revisions.filter(
				(row) =>
					plan === undefined &&
					row.business === business &&
					row.paidOn.start >= filing.period.start &&
					row.paidOn.end <= filing.period.end &&
					(employee === undefined || row.employee === employee)
			)
			const basis = new Set(
				data.bases.filter((row) => row.version === version?.id).map((row) => row.revision)
			)
			const adjustmentIds = new Set(
				data.adjustmentBases.filter((row) => row.version === version?.id).map((row) => row.adjustment)
			)
			const currentAdjustments = data.formAdjustments.filter((row) => row.filing === filing.id)
			const retirementStale =
				plan !== undefined &&
				version?.origin === "Prepared" &&
				data.retirementBases.find((r) => r.version === version.id)?.digest !==
					(yield* retirementFilingDigest(snapshot, plan, filing.period))
			// UUIDv7 ids are the clock: a revision minted after an attested
			// version is newer information than that version.
			const stale =
				retirementStale ||
				(version !== undefined &&
					(version.origin === "Prepared"
						? expected.length !== basis.size ||
							expected.some((row) => !basis.has(row.id)) ||
							currentAdjustments.length !== adjustmentIds.size ||
							currentAdjustments.some((row) => !adjustmentIds.has(row.id))
						: expected.some((row) => row.id > version.id)))
			// A submitted snapshot stays submitted. Later facts create correction
			// work on the leaf of its explicit amendment chain.
			if (completed && stale && !data.corrections.some((row) => row.parent === filing.id))
				setup("filing-correction", filing.id, `${filing.form} has changed since submission`, {
					op: "filings.amend",
					input: { parent: filing.id }
				})
			const deadline = deadlines.get(filing.id)
			work.push(
				workItem({
					rule: "filing",
					subject: filing.id,
					label: filing.form,
					opensOn: epochDay(filing.opensOn),
					dueOn: epochDay(deadline?.dueOn ?? filing.dueOn),
					complete: completed,
					evidence: deadline?.evidence ?? filing.evidence,
					next: completed
						? { op: "filings.inspect", input: {} }
						: version && !stale
							? { op: "filings.submit", input: { version: version.id } }
							: { op: "filings.prepare", input: { filing: filing.id } }
				})
			)
		}
		const requirements = data.requirements.filter(
			(row) =>
				row.business === business &&
				row.startsOn <= asOf &&
				!data.ends.some((end) => end.requirement === row.id && end.endsBefore <= asOf)
		)
		for (const [form, policy] of Object.entries(formPolicy)) {
			if (policy.due === "RecordedEvent") continue
			if (!requirements.some((row) => row.form === form))
				setup("filing-requirement", form, `Missing ${form} requirement`, {
					op: "filings.ensure",
					input: { throughYear: Number(year) }
				})
		}
		for (const requirement of requirements) {
			if (formPolicy[requirement.form].due === "RecordedEvent") continue
			const scopes = data.scopes.filter((row) => row.requirement === requirement.id)
			const expectedSubjects = data.subjects.filter(
				(row) =>
					row.business === business &&
					row.kind === requirement.subjectKind &&
					(row.kind === "Business" ||
						data.employeeSubjects.some(
							(subject) =>
								subject.subject === row.id &&
								data.revisions.some(
									(revision) =>
										revision.employee === subject.employee &&
										revision.paidOn.start >= yearSpan.start &&
										revision.paidOn.end <= yearSpan.end
								)
						))
			)
			const ensure = { op: "filings.ensure", input: { throughYear: Number(year) } }
			if (requirement.subjectKind === "Business" && !expectedSubjects.length)
				setup("filing-subject", requirement.id, `Missing ${requirement.form} business subject`, ensure)
			for (const subject of expectedSubjects) {
				if (
					scopes.some(
						(scope) => scope.subject === subject.id && scope.span.start <= asOf && scope.span.end > asOf
					)
				)
					continue
				setup(
					"filing-scope",
					`${requirement.id}/${subject.id}`,
					`${requirement.form} coverage does not include this payroll date`,
					ensure
				)
			}
			if (requirement.subjectKind === "Employee") {
				for (const employee of employees.filter((row) =>
					data.revisions.some(
						(revision) =>
							revision.employee === row.id &&
							revision.paidOn.start >= yearSpan.start &&
							revision.paidOn.end <= yearSpan.end
					)
				)) {
					if (!data.employeeSubjects.some((row) => row.employee === employee.id))
						setup(
							"filing-subject",
							`${requirement.id}/${employee.id}`,
							`Missing ${requirement.form} employee subject`,
							ensure
						)
				}
			}
		}
		for (const family of S.AccountFamily.handles)
			if (!data.accounts.some((row) => row.business === business && row.family === family))
				setup("tax-account", family, `Missing ${family} tax account`, { op: "business.configure", input: {} })
		for (const employee of employees) {
			if (!data.budgets.some((row) => row.employee === employee.id && row.year === year))
				setup("annual-budget", `${employee.id}/${year}`, "Missing annual compensation budget", {
					op: "compensation.budget",
					input: { employee: employee.id, year: Number(year) }
				})
		}
		for (const commitment of data.commitments.filter(
			(row) => employeeIds.has(row.employee) && row.year === year
		)) {
			if (!data.assignments.some((row) => row.commitment === commitment.id))
				setup(
					"budget-assignment",
					commitment.id,
					"Observed compensation is not assigned to its annual budget",
					{
						op: "compensation.assign",
						input: { commitment: commitment.id }
					}
				)
		}
		const entries = data.entries.filter((row) => row.business === business)
		const byEntry = new Map(entries.map((entry) => [entryKey(entry), entry]))
		const allocated = new Set<string>()
		const acceptedReconciliations = new Set<Uuid>()
		const unresolvedAccounts = new Set<Uuid>()
		for (const payment of data.payments.filter((row) => row.business === business)) {
			const reconciliation = data.reconciliations.find((row) => row.payment === payment.id)
			const allocations = reconciliation
				? data.allocations.filter((row) => row.reconciliation === reconciliation.id)
				: []
			const amounts = allocations.map((allocation) => {
				const entry = byEntry.get(entryKey(allocation))
				if (!entry)
					throw new Refusal({ code: "LiabilityMissing", message: `No derived entry ${entryKey(allocation)}` })
				return entry.amount
			})
			const adjustments = reconciliation
				? data.adjustments.filter((row) => row.reconciliation === reconciliation.id).map((row) => row.amount)
				: []
			const equation = paymentEquation(payment.amount, amounts, adjustments)
			if (reconciliation && equation.difference === 0n) {
				acceptedReconciliations.add(reconciliation.id)
				for (const allocation of allocations) allocated.add(entryKey(allocation))
			}
			if (!reconciliation || equation.difference !== 0n) {
				unresolvedAccounts.add(payment.account)
				work.push(
					workItem({
						rule: "payment-reconciliation",
						subject: payment.id,
						label: "Account for money already sent",
						opensOn: asOf,
						complete: false,
						amount: equation.difference,
						evidence: payment.evidence,
						next: { op: "payment.reconcile", input: { payments: [{ payment: payment.id }] } }
					})
				)
			}
		}
		const openQuestions = (yield* questions(snapshot, business)).filter((q) => !q.answer)
		for (const question of openQuestions) {
			if (question.kind === "TaxAccount") {
				if (question.account) unresolvedAccounts.add(question.account)
				work.push(
					workItem({
						rule: "tax-account-question",
						subject: question.id,
						label: question.detail,
						opensOn: asOf,
						complete: false,
						evidence: question.evidence,
						next: { op: "payment.reconcile", input: { resolveIssues: [question.id] } }
					})
				)
			}
			if (question.kind === "Review")
				readiness.push({ id: question.id, kind: "Question", detail: question.detail })
		}
		const disposed = new Set(data.dispositions.map(entryKey))
		for (const entry of entries.filter(
			(row) => row.amount < 0n && !allocated.has(entryKey(row)) && !disposed.has(entryKey(row))
		)) {
			work.push(
				workItem({
					rule: "negative-liability",
					subject: entryKey(entry),
					label: "Resolve the tax reduction without assuming a refund or credit",
					opensOn: asOf,
					complete: false,
					amount: entry.amount,
					next: { op: "payment.dispose", input: { revision: entry.revision, account: entry.account } }
				})
			)
		}
		const amendmentEntries = new Set(data.amendments.filter((row) => row.business === business).map(entryKey))
		for (const amendment of data.amendments.filter((row) => row.business === business)) {
			const entry = byEntry.get(entryKey(amendment))
			const filing = filings.find((row) => row.id === amendment.filing)
			if (!entry || !filing)
				throw new Refusal({
					code: "AmendmentScope",
					message: "An amendment does not match its business or liability"
				})
			if (entry.amount <= 0n) continue
			const paid = allocated.has(entryKey(entry))
			work.push(
				workItem({
					rule: "correction-payment",
					subject: entryKey(entry),
					label: `${filing.form} correction payment`,
					opensOn: epochDay(filing.opensOn),
					dueOn: epochDay(deadlines.get(filing.id)?.dueOn ?? filing.dueOn),
					complete: paid,
					amount: paid ? 0n : entry.amount,
					evidence: amendment.evidence,
					next: unresolvedAccounts.has(entry.account)
						? { op: "payment.reconcile", input: {} }
						: { op: "payment.record", input: { account: entry.account } }
				})
			)
		}
		const deposits = yield* depositRegister(snapshot, business, amendmentEntries, acceptedReconciliations)
		for (const deposit of deposits.deposits) {
			const family = data.accounts.find((row) => row.id === deposit.account)?.family ?? deposit.account
			work.push(
				workItem({
					rule: "deposit",
					subject: deposit.checkpoint,
					label: `${family} deposit`,
					opensOn: deposit.opensOn,
					dueOn: deposit.dueOn,
					complete: deposit.disposition !== "Carryover" && deposit.outstanding === 0n,
					carryover: deposit.disposition === "Carryover",
					amount: deposit.outstanding,
					evidence: deposit.evidence,
					next: unresolvedAccounts.has(deposit.account)
						? { op: "payment.reconcile", input: {} }
						: { op: "payment.record", input: { account: deposit.account, amount: deposit.outstanding } }
				})
			)
		}
		const install = { op: "policy.install", input: {} }
		for (const entry of deposits.uncovered)
			setup("deposit-coverage", entryKey(entry), "Missing deposit coverage for a posted liability", install)
		for (const account of data.accounts.filter((row) => row.business === business)) {
			if (
				!deposits.checkpoints.some(
					(row) => row.account === account.id && row.span.start <= asOf && asOf < row.span.end
				)
			)
				setup(
					"deposit-coverage",
					account.id,
					`Missing current deposit calendar for ${account.family}`,
					install
				)
		}
		for (const employee of employees.filter(
			(row) =>
				!data.elections.some(
					(election) =>
						election.employee === row.id &&
						election.year === year &&
						election.signedOn <= asOf &&
						election.effective.start <= asOf &&
						election.effective.end > asOf
				)
		))
			readiness.push({
				id: employee.id,
				kind: "ElectionMissing",
				detail: data.electionDocuments.some((row) => row.employee === employee.id && row.year === year)
					? "Signed election document recorded; verify its effective timing and employee allowance before authorizing new Roth deductions"
					: "No applicable election is recorded for new Roth payroll"
			})
		for (const deduction of data.deductions.filter(
			(row) => employeeIds.has(row.employee) && row.kind === "Recovery"
		)) {
			const equation = recoveryEquation(
				deduction.amount,
				data.recoveries.filter((row) => row.fromWage === deduction.wage).map((row) => row.amount)
			)
			if (equation.difference !== 0n)
				readiness.push({
					id: deduction.wage,
					kind: "RecoveryUnattributed",
					detail: `${equation.difference} cents of actual recovery deductions need attribution: recovery.record`
				})
		}
		for (const position of employeeTaxPositions(data.assessed, data.deductions, data.recoveries).filter(
			(row) => row.business === business
		)) {
			if (position.remaining !== 0n)
				readiness.push({
					id: `${position.wage}/${position.component}`,
					kind: position.remaining > 0n ? "EmployeeTaxOwed" : "EmployeeTaxExcess",
					detail: `${position.remaining} cents between current ${position.component} assessment and actual withholding/recoveries`
				})
		}
		const documents = yield* inspectDocuments(snapshot)
		if (documents.some((document) => document.archived))
			for (const document of documents.filter((document) => !document.archived))
				readiness.push({
					id: document.id,
					kind: "DocumentUnarchived",
					detail: "Required evidence has no verified Drive copy: artifact.archive"
				})
		work.push(...(yield* bookkeepingWork(snapshot, business, asOf)))
		work.sort((a, b) => (a.opensOn < b.opensOn ? -1 : a.opensOn > b.opensOn ? 1 : a.id.localeCompare(b.id)))
		const blockers = work.filter(
			(item) => item.gates === "Payroll" && item.status === "Open" && item.opensOn <= asOf
		)
		return { business: company.id, asOf, state: snapshot.stateStamp, work, blockers, readiness }
	})

export const requirePayrollReady = (snapshot: Snapshot, business: Uuid, asOf: UnixEpochDay) =>
	Effect.gen(function* () {
		const register = yield* workRegister(snapshot, business, asOf)
		if (register.blockers.length)
			return yield* Effect.fail(
				new Refusal({
					code: "PayrollBlocked",
					message: JSON.stringify(
						register.blockers.map((item) => ({ id: item.id, label: item.label, next: item.next.op })),
						(_, value) => (typeof value === "bigint" ? value.toString() : value)
					)
				})
			)
		return register
	})
