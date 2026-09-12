import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { test } from "node:test"
import { ChangeSet, type Fact, query, v } from "@bjornpagen/bumbledb"
import { Effect } from "effect"
import { io } from "../src/core/files.ts"
import { civilDayPoint, epochDay, periodSpan } from "../src/core/time.ts"
import { json, mintId } from "../src/core/values.ts"
import { amendFiling, prepareFiling, rejectFiling, reviseDeadline, submitFiling } from "../src/filings.ts"
import { revisePayrollTax } from "../src/payroll.ts"
import { relationRows, rows } from "../src/queries.ts"
import { type Draft, Ledger, latest } from "../src/runtime.ts"
import { components } from "../src/schema/vocabulary.ts"
import * as S from "../src/schema.ts"
import { workRegister } from "../src/work.ts"
import { apply, bankForWage, withHistory } from "./native-history.ts"

const packet = (draft: Draft, invalid?: "receipt" | "slot" | "role" | "scope" | "version" | "unsubmitted") =>
	Effect.gen(function* () {
		const submissionRows: Fact<typeof S.Submission>[] = []
		const sidecars: Fact<typeof S.CertifiedMailSubmission>[] = []
		const manifests: Fact<typeof S.SubmissionDocument>[] = []
		const business = yield* mintId
		const employee = yield* mintId
		const subject = yield* mintId
		const release = yield* mintId
		const canonical = yield* mintId
		const mailing = yield* mintId
		const receipt = yield* mintId
		const document = yield* mintId
		const evidence = "Synthetic certified packet qualification"
		const period = periodSpan(2026, "Year")
		yield* draft.insert(S.Business, [
			{
				id: business,
				name: "Mailing Test",
				ein: "00-0000002",
				state: "TX",
				timeZone: "America/Chicago",
				recordedAt: 0n
			}
		])
		yield* draft.insert(S.Employee, [
			{
				id: employee,
				business,
				firstName: "Test",
				lastName: "Only",
				ssn: "000-00-0000",
				address: "Synthetic",
				filingStatus: "Single",
				recordedAt: 0n
			}
		])
		yield* draft.insert(S.FilingSubject, [{ id: subject, business, kind: "Employee" }])
		yield* draft.insert(S.EmployeeSubject, [{ subject, employee, business }])
		yield* draft.insert(S.PolicyRelease, [
			{ id: release, sha256: "packet-policy", title: evidence, evidence, recordedAt: 0n }
		])
		yield* draft.insert(S.CalendarCoverage, [{ release, authority: "FederalDC", kind: "Year", span: period }])
		yield* draft.insert(S.CalendarPeriod, [
			{ id: canonical, release, authority: "FederalDC", kind: "Year", span: period, year: 2026n, ordinal: 1n }
		])
		yield* draft.insert(S.Artifact, [
			{ id: receipt, sha256: "synthetic-receipt", mediaType: "text/plain" },
			{
				id: document,
				sha256: createHash("sha256").update("synthetic-forms").digest("hex"),
				mediaType: "text/plain"
			}
		])
		yield* draft.insert(S.CertifiedMailing, [
			{
				id: mailing,
				business,
				carrier: "USPS",
				number: "SYNTHETIC-ONE-PACKET",
				mailedOn: period.end,
				receipt,
				evidence
			}
		])
		yield* draft.insert(S.MailingEvidence, [{ mailing, artifact: receipt }])
		const forms = ["W2SSA", "W2Employee"] as const
		const scopeIds = [yield* mintId, yield* mintId] as const
		const versionIds = [yield* mintId, yield* mintId] as const
		for (const [index, form] of forms.entries()) {
			const requirement = yield* mintId
			const filing = yield* mintId
			const policy = yield* mintId
			const submission = yield* mintId
			const scope = scopeIds[index]
			const version = versionIds[index]
			assert.ok(scope)
			assert.ok(version)
			const slots = form === "W2SSA" ? (["Return", "Transmittal"] as const) : (["Return"] as const)
			yield* draft.insert(S.FilingRequirement, [
				{ id: requirement, business, form, subjectKind: "Employee", startsOn: period.start, evidence }
			])
			yield* draft.insert(S.FilingScope, [
				{ id: scope, requirement, subject, business, form, kind: "Year", span: period }
			])
			yield* draft.insert(S.Filing, [
				{
					id: filing,
					requirement,
					subject,
					business,
					form,
					period,
					kind: "Original",
					opensOn: period.end,
					dueOn: period.end + 30n,
					evidence
				}
			])
			yield* draft.insert(S.OriginalFiling, [
				{
					filing,
					scope: invalid === "scope" ? (scopeIds[1 - index] ?? scope) : scope,
					requirement,
					subject,
					business,
					form,
					canonical,
					kind: "Year",
					period
				}
			])
			yield* draft.insert(S.FilingVersion, [
				{
					id: version,
					filing,
					business,
					form,
					release,
					sequence: 1n,
					origin: "Prepared",
					evidence,
					recordedAt: 0n
				}
			])
			yield* draft.insert(S.PreparedVersion, [{ version, snapshot: "{}" }])
			yield* draft.insert(S.FormMethodPolicy, [
				{ id: policy, release, form, method: "CertifiedMail", requiredCount: BigInt(slots.length) }
			])
			submissionRows.push({
				id: submission,
				version,
				business,
				form,
				release,
				policy,
				method: "CertifiedMail",
				requiredCount: BigInt(slots.length),
				recordedAt: 0n
			})
			if (invalid !== "receipt") sidecars.push({ submission, version, business, mailing })
			for (const slot of slots) {
				const role = invalid === "role" ? "Receipt" : slot
				yield* draft.insert(S.DocumentRequirement, [{ policy, slot, role }])
				yield* draft.insert(S.FilingDocument, [{ version, slot, role, artifact: document, part: slot }])
				if (invalid === "slot" && slot === "Transmittal") continue
				manifests.push({
					submission,
					version: invalid === "version" ? (versionIds[1 - index] ?? version) : version,
					policy,
					slot,
					role,
					artifact: document,
					part: slot
				})
			}
		}
		if (invalid !== "unsubmitted") {
			yield* draft.insert(S.Submission, submissionRows)
			yield* draft.insert(S.CertifiedMailSubmission, sidecars)
			yield* draft.insert(S.SubmissionDocument, manifests)
		}
		return {
			business,
			canonical,
			employee,
			release,
			document,
			period,
			submissionRows,
			sidecars,
			manifests,
			asOf: epochDay(period.end)
		}
	})

const mailings = query(S.ledger).rule((r) => {
	const row = v(S.CertifiedMailing)
	return r.match(S.CertifiedMailing, row).find(row)
})

test("filing commands capture immutable figures, resolve digital acknowledgements, and expose later correction work", async () => {
	await withHistory((history, binding, directory) =>
		Effect.gen(function* () {
			const seed = yield* ChangeSet.builder(S.ledger)
			const fixture = yield* packet(seed, "unsubmitted")
			const { business, employee, release, document, period } = fixture
			const evidence = "Synthetic filing command qualification"
			yield* seed.insert(S.PolicyBinding, [{ business, release, evidence }])
			const policy = yield* mintId
			yield* seed.insert(S.FormMethodPolicy, [
				{ id: policy, release, form: "W2Employee", method: "Digital", requiredCount: 1n }
			])
			yield* seed.insert(S.DocumentRequirement, [{ policy, slot: "Return", role: "Return" }])
			assert.equal((yield* apply(history, yield* seed.finish())).outcome.kind, "committed")
			const versionFacts = query(S.ledger).rule((r) => {
				const row = v(S.FilingVersion)
				return r.match(S.FilingVersion, row).find(row)
			})
			const filingFacts = query(S.ledger).rule((r) => {
				const row = v(S.Filing)
				return r.match(S.Filing, row).find(row)
			})
			const basisFacts = query(S.ledger).rule((r) => {
				const row = v(S.FilingBasis)
				return r.match(S.FilingBasis, row).find(row)
			})
			let snapshot = yield* history.snapshot({ consistency: { kind: "latest" } })
			const filing = (yield* rows(snapshot, filingFacts, {})).find((row) => row.form === "W2Employee")
			assert.ok(filing)
			const file = path.join(directory, "synthetic-return.txt")
			yield* io("write synthetic form", () => fs.writeFile(file, "synthetic-forms"))
			const prepareInput = {
				request: yield* mintId,
				business,
				filing: filing.id,
				evidence,
				documents: [{ slot: "Return", role: "Return", artifact: document, part: "Return", file }]
			}
			yield* prepareFiling(prepareInput)
			snapshot = yield* history.snapshot({ consistency: { kind: "latest" } })
			const version = (yield* rows(snapshot, versionFacts, {})).find(
				(row) => row.filing === filing.id && row.sequence === 2n
			)
			assert.ok(version)
			assert.equal(
				(yield* workRegister(snapshot, business, fixture.asOf)).work.find((row) => row.id === filing.id)
					?.completion,
				"Open"
			)
			const submitInput = {
				request: yield* mintId,
				business,
				version: version.id,
				method: {
					kind: "Digital",
					submittedOn: "2026-09-10",
					evidence,
					reference: { value: "SYNTHETIC-DELIVERY", sourceText: evidence }
				},
				manifest: [{ slot: "Return", file }]
			}
			assert.equal(
				(yield* Effect.result(submitFiling({ ...submitInput, request: yield* mintId, manifest: [] })))._tag,
				"Failure",
				"a digital method still requires the declared document manifest"
			)
			const submitted = yield* submitFiling(submitInput)
			assert.equal(submitted.outcome.kind, "committed")
			assert.ok(submitted.outcome.kind === "committed")
			const submission = submitted.outcome.result.submission
			const repeated = yield* submitFiling({ ...submitInput, request: yield* mintId })
			assert.equal(repeated.outcome.kind, "no-change")
			assert.equal(
				(yield* Effect.result(submitFiling({ ...submitInput, request: yield* mintId, manifest: [] })))._tag,
				"Failure",
				"external identity cannot hide a conflicting manifest"
			)
			assert.equal(
				(yield* Effect.result(
					submitFiling({
						...submitInput,
						request: yield* mintId,
						method: { ...submitInput.method, submittedOn: "2026-09-09" }
					})
				))._tag,
				"Failure"
			)
			assert.equal(
				(yield* Effect.result(prepareFiling({ ...prepareInput, request: yield* mintId })))._tag,
				"Failure",
				"a submitted version requires an explicit correction"
			)
			const added = yield* ChangeSet.builder(S.ledger)
			const wage = yield* mintId,
				commitment = yield* mintId,
				revision = yield* mintId,
				set = yield* mintId
			const paidOn = civilDayPoint(epochDay(period.start + 14n))
			yield* added.insert(S.BudgetCommitment, [
				{ id: commitment, employee, year: 2026n, amount: 10000n, origin: "Regular", evidence }
			])
			yield* added.insert(S.RegularCommitment, [{ commitment, wage }])
			yield* added.insert(S.RegularWork, [{ wage, employee, span: periodSpan(2026, "Month", 1) }])
			yield* bankForWage(added, wage, business, paidOn.start, 10000n)
			yield* added.insert(S.Wage, [
				{
					requiresTransfer: true,
					id: wage,
					calendar: fixture.canonical,
					year: 2026n,
					business,
					employee,
					commitment,
					paidOn,
					gross: 10000n,
					initialRevision: revision,
					recordedAt: 0n
				}
			])
			yield* added.insert(S.AssessmentSet, [
				{ id: set, business, employee, paidOn, gross: 10000n, origin: "Observed" }
			])
			yield* added.insert(S.ObservedSet, [{ set, evidence }])
			yield* added.insert(S.AssessmentRevision, [
				{
					id: revision,
					wage,
					set,
					business,
					employee,
					paidOn,
					gross: 10000n,
					kind: "Initial",
					recordedAt: 0n
				}
			])
			for (const family of S.AccountFamily.handles) {
				const account = yield* mintId
				yield* added.insert(S.TaxAccount, [{ id: account, business, family, evidence }])
				yield* added.insert(S.RevisionAccount, [{ revision, account, business, family }])
			}
			for (const component of components) {
				yield* added.insert(S.Assessment, [{ set, component, origin: "Observed", method: "SuppliedAmount" }])
				yield* added.insert(S.ObservedAssessment, [{ set, component, amount: 0n, evidence }])
			}
			assert.equal((yield* apply(history, yield* added.finish())).outcome.kind, "committed")
			snapshot = yield* history.snapshot({ consistency: { kind: "latest" } })
			const changed = yield* workRegister(snapshot, business, fixture.asOf)
			assert.ok(
				changed.work.some((row) => row.id === `correction/${filing.id}` && row.action === "filings amend")
			)
			assert.equal(
				changed.work.find((row) => row.id === filing.id)?.completion,
				"Complete",
				"original submission remains an observed fact"
			)
			yield* rejectFiling({ request: yield* mintId, business, submission, evidence })
			yield* prepareFiling({ ...prepareInput, request: yield* mintId })
			snapshot = yield* history.snapshot({ consistency: { kind: "latest" } })
			const fresh = (yield* rows(snapshot, versionFacts, {})).find(
				(row) => row.filing === filing.id && row.sequence === 3n
			)
			assert.ok(fresh)
			assert.ok(
				(yield* rows(snapshot, basisFacts, {})).some(
					(row) => row.version === fresh.id && row.revision === revision
				)
			)
			yield* reviseDeadline({
				request: yield* mintId,
				business,
				filing: filing.id,
				dueOn: "2027-02-15",
				evidence
			})
			snapshot = yield* history.snapshot({ consistency: { kind: "latest" } })
			const updated = yield* workRegister(snapshot, business, fixture.asOf)
			assert.equal(updated.work.find((row) => row.id === filing.id)?.action, "filings submit")
			const adjustment = { id: yield* mintId, filing: filing.id, amount: 1n, evidence }
			const adjust = yield* ChangeSet.builder(S.ledger)
			yield* adjust.insert(S.FormAdjustment, [adjustment])
			yield* apply(history, yield* adjust.finish())
			const staleFigures = yield* workRegister(
				yield* history.snapshot({ consistency: { kind: "latest" } }),
				business,
				fixture.asOf
			)
			assert.equal(
				staleFigures.work.find((row) => row.id === filing.id)?.action,
				"filings prepare",
				"a new return adjustment invalidates preparation even if revisions are unchanged"
			)
			const undo = yield* ChangeSet.builder(S.ledger)
			yield* undo.delete(S.FormAdjustment, [adjustment])
			yield* apply(history, yield* undo.finish())
			yield* submitFiling({
				...submitInput,
				request: yield* mintId,
				version: fresh.id,
				method: {
					...submitInput.method,
					reference: { value: "SYNTHETIC-RESUBMISSION", sourceText: evidence }
				}
			})
			const amendInput = {
				request: yield* mintId,
				business,
				parent: filing.id,
				discoveredOn: "2026-09-10",
				dueOn: "2026-09-10",
				evidence,
				revisions: [revision]
			}
			const amended = yield* amendFiling(amendInput)
			assert.equal(amended.outcome.kind, "committed")
			assert.ok(amended.outcome.kind === "committed")
			const correction = amended.outcome.result.filing
			assert.equal(
				(yield* Effect.result(amendFiling({ ...amendInput, request: yield* mintId })))._tag,
				"Failure",
				"correction chains cannot fork"
			)
			snapshot = yield* history.snapshot({ consistency: { kind: "latest" } })
			const correctionWork = yield* workRegister(snapshot, business, fixture.asOf)
			assert.ok(
				correctionWork.blockers.some((row) => row.id === correction && row.kind === "Filing"),
				"a zero-tax correction still requires submission"
			)
			const amendmentFacts = query(S.ledger).rule((r) => {
				const row = v(S.AmendmentLiability)
				return r.match(S.AmendmentLiability, row).find(row)
			})
			assert.equal(
				(yield* rows(snapshot, amendmentFacts, {})).length,
				0,
				"an employee-copy correction does not become an IRS payment instruction"
			)
			const revised = yield* revisePayrollTax({
				request: yield* mintId,
				business,
				assessment: {
					kind: "Observed",
					wage,
					predecessor: revision,
					figures: {
						amounts: Object.fromEntries(components.map((component) => [component, "0"])),
						taxableWages: [],
						evidence
					}
				}
			})
			assert.ok(revised.outcome.kind === "committed")
			assert.equal(
				revised.outcome.result.amendmentsJson,
				json([correction]),
				"an open correction is reused atomically"
			)
			yield* prepareFiling({ ...prepareInput, request: yield* mintId, filing: correction })
			const correctedVersion = (yield* relationRows(yield* latest, S.FilingVersion)).find(
				(row) => row.filing === correction
			)
			assert.ok(correctedVersion)
			yield* submitFiling({
				...submitInput,
				request: yield* mintId,
				version: correctedVersion.id,
				method: { ...submitInput.method, reference: { value: "SYNTHETIC-CORRECTION", sourceText: evidence } }
			})
			const secondRevision = yield* revisePayrollTax({
				request: yield* mintId,
				business,
				assessment: {
					kind: "Observed",
					wage,
					predecessor: revised.outcome.result.revision,
					figures: {
						amounts: Object.fromEntries(components.map((component) => [component, "0"])),
						taxableWages: [],
						evidence
					}
				},
				amendments: [{ parent: correction, dueOn: "2026-09-11", evidence }]
			})
			assert.ok(secondRevision.outcome.kind === "committed")
			const chain = yield* relationRows(yield* latest, S.CorrectionFiling)
			assert.equal(chain.length, 2)
			assert.ok(
				chain.some((row) => row.parent === correction),
				"a submitted correction gets a distinct successor automatically"
			)
			assert.equal((yield* relationRows(yield* latest, S.AmendmentLiability)).length, 0)
		}).pipe(
			Effect.provideService(Ledger, { history, binding, recoveryDirectory: path.join(directory, "requests") })
		)
	)
})
const submissions = query(S.ledger).rule((r) => {
	const row = v(S.CertifiedMailSubmission)
	return r.match(S.CertifiedMailSubmission, row).find(row)
})

test("a shared certified mailing requires each form's matching scope, method evidence and exact document slots", async () => {
	await withHistory((history) =>
		Effect.gen(function* () {
			const baseline = yield* history.snapshot({ consistency: { kind: "latest" } })
			for (const invalid of ["receipt", "slot", "role", "scope", "version"] as const) {
				const draft = yield* ChangeSet.builder(S.ledger)
				yield* packet(draft, invalid)
				assert.equal(
					(yield* apply(history, yield* draft.finish())).outcome.kind,
					"invariant-rejected",
					invalid
				)
				assert.deepEqual(
					(yield* history.snapshot({ consistency: { kind: "latest" } })).stateStamp,
					baseline.stateStamp
				)
			}
			const draft = yield* ChangeSet.builder(S.ledger)
			const prepared = yield* packet(draft, "unsubmitted")
			assert.equal((yield* apply(history, yield* draft.finish())).outcome.kind, "committed")
			const before = yield* history.snapshot({ consistency: { kind: "latest" } })
			const pending = yield* workRegister(before, prepared.business, prepared.asOf).pipe(
				Effect.mapError((error) => new Error(`Before submission: ${json(error)}`))
			)
			assert.equal(
				pending.blockers.filter((row) => row.kind === "Filing").length,
				2,
				"preparation does not clear filing work"
			)
			const submit = yield* ChangeSet.builder(S.ledger)
			yield* submit.insert(S.Submission, prepared.submissionRows)
			yield* submit.insert(S.CertifiedMailSubmission, prepared.sidecars)
			yield* submit.insert(S.SubmissionDocument, prepared.manifests)
			assert.equal((yield* apply(history, yield* submit.finish())).outcome.kind, "committed")
			const snapshot = yield* history.snapshot({ consistency: { kind: "latest" } })
			const physical = yield* rows(snapshot, mailings, {})
			const filed = yield* rows(snapshot, submissions, {})
			assert.equal(physical.length, 1)
			assert.equal(filed.length, 2)
			assert.ok(filed.every((row) => row.mailing === physical[0]?.id))
			const complete = yield* workRegister(snapshot, prepared.business, prepared.asOf).pipe(
				Effect.mapError((error) => new Error(`After submission: ${json(error)}`))
			)
			assert.equal(complete.blockers.filter((row) => row.kind === "Filing").length, 0)
			assert.equal(
				complete.work.filter((row) => row.kind === "Filing" && row.completion === "Complete").length,
				2
			)
			assert.deepEqual(
				(yield* history.snapshot({ consistency: { kind: "latest" } })).stateStamp,
				snapshot.stateStamp,
				"register reads do not synchronize or mutate"
			)
			const firstSubmission = filed[0]
			assert.ok(firstSubmission)
			const reject = yield* ChangeSet.builder(S.ledger)
			yield* reject.insert(S.Rejection, [
				{ submission: firstSubmission.submission, evidence: "Synthetic agency rejection", recordedAt: 1n }
			])
			assert.equal((yield* apply(history, yield* reject.finish())).outcome.kind, "committed")
			const reopened = yield* workRegister(
				yield* history.snapshot({ consistency: { kind: "latest" } }),
				prepared.business,
				prepared.asOf
			)
			assert.equal(reopened.blockers.filter((row) => row.kind === "Filing").length, 1)
		})
	)
})
