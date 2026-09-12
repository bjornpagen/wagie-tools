import type { Fact, Uuid } from "@bjornpagen/bumbledb"
import { Effect, Schema } from "effect"
import { retirementActivity, retirementFilingDigest } from "./bookkeeping.ts"
import { businessCommand } from "./commands.ts"
import { civilDaySpan, epochDay, toCalendarDate, type UnixEpochDay } from "./core/time.ts"
import { json, mintId, Nonblank, Refusal } from "./core/values.ts"
import { verifyDocument } from "./evidence.ts"
import { currentAssessments, currentRevisions, relationRows, rows } from "./queries.ts"
import { periodFigures } from "./reports.ts"
import { type Draft, parseStrict, type Snapshot } from "./runtime.ts"
import { commandFields, Day, Id, inputFields } from "./schema/input.ts"
import { formPolicy } from "./schema/vocabulary.ts"
import * as S from "./schema.ts"
import { workRegister } from "./work.ts"

const filingRevision = (
	filing: Fact<typeof S.Filing>,
	revision: Fact<typeof S.AssessmentRevision>
): Fact<typeof S.FilingRevision> => {
	const family = formPolicy[filing.form].family
	if (family === null)
		throw new Refusal({ code: "FilingSubject", message: "Retirement forms use recorded retirement activity" })
	return {
		filing: filing.id,
		revision: revision.id,
		business: filing.business,
		subject: filing.subject,
		form: filing.form,
		family,
		employee: revision.employee,
		paidOn: revision.paidOn
	}
}

const uniqueSlots = (items: readonly { slot: string }[]) => {
	if (new Set(items.map((row) => row.slot)).size !== items.length)
		throw new Refusal({ code: "DuplicateDocumentSlot", message: "Supply each document slot once" })
}

const common = commandFields
const DocumentInput = Schema.Struct({
	...inputFields(S.FilingDocument, ["slot", "role", "artifact", "part"]),
	file: Nonblank
})
export const FilingPrepareInput = Schema.Struct({
	...common,
	...inputFields(S.FilingVersion, ["filing", "evidence"]),
	documents: Schema.Array(DocumentInput)
})

const newest = (values: readonly Fact<typeof S.FilingVersion>[], filing: string) =>
	values
		.filter((row) => row.filing === filing)
		.reduce<Fact<typeof S.FilingVersion> | undefined>(
			(a, b) => (!a || b.sequence > a.sequence ? b : a),
			undefined
		)

export const prepareFiling = (payload: unknown) =>
	Effect.gen(function* () {
		const input = parseStrict(FilingPrepareInput, payload)
		uniqueSlots(input.documents)
		const business = input.business
		return yield* businessCommand({
			request: input.request,
			business,
			action: "filings prepare",
			input: payload,
			plan: ({ snapshot, draft, recordingDay, recordedAt }) =>
				Effect.gen(function* () {
					const filing = (yield* relationRows(snapshot, S.Filing)).find(
						(row) => row.id === input.filing && row.business === business
					)
					if (!filing)
						return yield* Effect.fail(
							new Refusal({ code: "FilingMissing", message: `No matching filing ${input.filing}` })
						)
					const register = yield* workRegister(snapshot, business, recordingDay)
					if (register.work.some((row) => row.id === filing.id && row.completion === "Complete"))
						return yield* Effect.fail(
							new Refusal({
								code: "AlreadySubmitted",
								message: "Keep the submitted version; create an explicit correction for changed contents"
							})
						)
					const binding = (yield* relationRows(snapshot, S.PolicyBinding)).find(
						(row) => row.business === business
					)
					if (!binding)
						return yield* Effect.fail(
							new Refusal({
								code: "PolicyMissing",
								message: "Activate a reviewed policy release before preparing a filing"
							})
						)
					const previous = newest(yield* relationRows(snapshot, S.FilingVersion), filing.id)
					const employee = (yield* relationRows(snapshot, S.EmployeeSubject)).find(
						(row) => row.subject === filing.subject
					)?.employee
					const plan = (yield* relationRows(snapshot, S.PlanSubject)).find(
						(r) => r.subject === filing.subject
					)?.plan
					const revisions = (yield* rows(snapshot, currentRevisions, {})).filter(
						(row) =>
							plan === undefined &&
							row.business === business &&
							row.paidOn.start >= filing.period.start &&
							row.paidOn.end <= filing.period.end &&
							(employee === undefined || employee === row.employee)
					)
					const revisionIds = new Set(revisions.map((row) => row.id))
					const assessments = (yield* rows(snapshot, currentAssessments, {})).filter((row) =>
						revisionIds.has(row.revision)
					)
					const version = yield* mintId
					const figures = yield* periodFigures(
						snapshot,
						business,
						civilDaySpan(epochDay(filing.period.start), epochDay(filing.period.end)),
						employee
					)
					for (const document of input.documents)
						yield* verifyDocument(snapshot, document.artifact, document.file)
					yield* draft.insert(S.FilingVersion, [
						{
							id: version,
							filing: filing.id,
							business,
							form: filing.form,
							release: binding.release,
							sequence: (previous?.sequence ?? 0n) + 1n,
							origin: "Prepared",
							evidence: input.evidence,
							recordedAt
						}
					])
					yield* draft.insert(S.PreparedVersion, [
						{
							version,
							snapshot: json({
								revisions,
								assessments,
								figures: plan
									? yield* retirementActivity(
											snapshot,
											plan,
											toCalendarDate(epochDay(filing.period.start)).year
										)
									: figures,
								readiness: register.readiness,
								policyRelease: binding.release
							})
						}
					])
					yield* draft.insert(
						S.FilingAdjustmentBasis,
						figures.formAdjustments
							.filter((row) => row.filing === filing.id)
							.map((row) => ({ version, filing: filing.id, adjustment: row.id }))
					)
					yield* draft.insert(
						S.FilingRevision,
						revisions.map((revision) => filingRevision(filing, revision))
					)
					yield* draft.insert(
						S.FilingBasis,
						revisions.map((revision) => ({ version, filing: filing.id, revision: revision.id }))
					)
					if (plan)
						yield* draft.insert(S.RetirementFilingBasis, [
							{
								version,
								filing: filing.id,
								digest: yield* retirementFilingDigest(snapshot, plan, filing.period)
							}
						])
					yield* draft.insert(
						S.FilingDocument,
						input.documents.map(({ file: _file, ...document }) => ({
							...document,
							artifact: document.artifact,
							version
						}))
					)
					return { filing: filing.id, version, revisionCount: BigInt(revisions.length) }
				})
		})
	})

const MethodInput = Schema.Union([
	Schema.Struct({
		kind: Schema.Literal("Grandfathered"),
		...inputFields(S.GrandfatheredSubmission, ["evidence"])
	}),
	Schema.Struct({
		kind: Schema.Literal("Digital"),
		...inputFields(S.DigitalSubmission, ["submittedOn", "evidence"], { submittedOn: Day }),
		reference: Schema.optional(Schema.Struct(inputFields(S.DigitalReference, ["value", "sourceText"])))
	}),
	Schema.Struct({
		kind: Schema.Literal("CertifiedMail"),
		...inputFields(S.CertifiedMailSubmission, ["mailing"])
	})
])
export const FilingSubmitInput = Schema.Struct({
	...common,
	...inputFields(S.Submission, ["version"]),
	method: MethodInput,
	manifest: Schema.Array(Schema.Struct({ slot: Nonblank, file: Nonblank }))
})

export const submitFiling = (payload: unknown) =>
	Effect.gen(function* () {
		const input = parseStrict(FilingSubmitInput, payload),
			business = input.business
		uniqueSlots(input.manifest)
		return yield* businessCommand({
			request: input.request,
			business,
			action: "filings submit",
			input: payload,
			plan: ({ snapshot, draft, recordingDay, recordedAt }) =>
				Effect.gen(function* () {
					const allVersions = yield* relationRows(snapshot, S.FilingVersion)
					const version = allVersions.find((row) => row.id === input.version && row.business === business)
					if (!version)
						return yield* Effect.fail(
							new Refusal({ code: "FilingVersionMissing", message: `No matching version ${input.version}` })
						)
					const method = input.method
					const available = (yield* relationRows(snapshot, S.FilingDocument)).filter(
						(row) => row.version === version.id
					)
					const selected: Fact<typeof S.FilingDocument>[] = []
					for (const item of input.manifest) {
						const document = available.find((row) => row.slot === item.slot)
						if (!document)
							return yield* Effect.fail(
								new Refusal({
									code: "DocumentMissing",
									message: `The version has no document in slot ${item.slot}`
								})
							)
						yield* verifyDocument(snapshot, document.artifact, item.file)
						selected.push(document)
					}
					const sameManifest = (submission: string) =>
						Effect.gen(function* () {
							const original = (yield* relationRows(snapshot, S.SubmissionDocument)).filter(
								(row) => row.submission === submission
							)
							if (
								original.length !== selected.length ||
								original.some((row) => !selected.some((item) => item.slot === row.slot))
							)
								return yield* Effect.fail(
									new Refusal({
										code: "SubmissionConflict",
										message: "This submission was recorded with a different document manifest"
									})
								)
						})
					// External-event resolution precedes freshness checks: a repeated
					// observation cannot create another submission or alter old contents.
					if (method.kind === "CertifiedMail") {
						const prior = (yield* relationRows(snapshot, S.CertifiedMailSubmission)).find(
							(row) => row.version === version.id && row.mailing === method.mailing
						)
						if (prior) {
							yield* sameManifest(prior.submission)
							return { filing: version.filing, version: version.id, submission: prior.submission }
						}
					}
					if (method.kind === "Digital" && method.reference) {
						const reference = method.reference
						const prior = (yield* relationRows(snapshot, S.DigitalReference)).find(
							(row) => row.filing === version.filing && row.value === reference.value
						)
						if (prior && prior.version !== version.id)
							return yield* Effect.fail(
								new Refusal({
									code: "SubmissionConflict",
									message: "This filing acknowledgement already identifies another version"
								})
							)
						if (prior) {
							yield* sameManifest(prior.submission)
							const original = (yield* relationRows(snapshot, S.DigitalSubmission)).find(
								(row) => row.submission === prior.submission
							)
							if (original?.submittedOn !== method.submittedOn)
								return yield* Effect.fail(
									new Refusal({
										code: "SubmissionConflict",
										message: "This acknowledgement was recorded with another submission date"
									})
								)
							return { filing: version.filing, version: version.id, submission: prior.submission }
						}
					}
					if (newest(allVersions, version.filing)?.id !== version.id)
						return yield* Effect.fail(
							new Refusal({ code: "VersionSuperseded", message: "Submit the latest prepared version" })
						)
					const register = yield* workRegister(snapshot, business, recordingDay)
					const work = register.work.find((row) => row.id === version.filing)
					if (work?.action === "filings prepare")
						return yield* Effect.fail(
							new Refusal({
								code: "FilingBasisChanged",
								message: "Prepare a fresh version against the current figures"
							})
						)
					const submitted = yield* relationRows(snapshot, S.Submission)
					const rejected = new Set((yield* relationRows(snapshot, S.Rejection)).map((row) => row.submission))
					const current = submitted.find((row) => row.version === version.id && !rejected.has(row.id))
					if (current)
						return yield* Effect.fail(
							new Refusal({
								code: "AlreadySubmitted",
								message: "This version already has an unrejected submission"
							})
						)
					const policy = (yield* relationRows(snapshot, S.FormMethodPolicy)).find(
						(row) =>
							row.release === version.release && row.form === version.form && row.method === method.kind
					)
					if (!policy)
						return yield* Effect.fail(
							new Refusal({
								code: "SubmissionPolicyMissing",
								message: "No reviewed submission policy matches this version and method"
							})
						)
					const submission = yield* mintId
					const manifest = selected.map((document) => ({ ...document, submission, policy: policy.id }))
					yield* draft.insert(S.Submission, [
						{
							id: submission,
							version: version.id,
							business,
							form: version.form,
							release: version.release,
							policy: policy.id,
							method: method.kind,
							requiredCount: policy.requiredCount,
							recordedAt
						}
					])
					switch (method.kind) {
						case "Grandfathered":
							yield* draft.insert(S.GrandfatheredSubmission, [
								{ submission, version: version.id, filing: version.filing, evidence: method.evidence }
							])
							break
						case "Digital": {
							const submittedOn = method.submittedOn
							if (submittedOn > recordingDay)
								return yield* Effect.fail(
									new Refusal({
										code: "FutureSubmission",
										message: "Record submission after it has occurred"
									})
								)
							yield* draft.insert(S.DigitalSubmission, [
								{ submission, submittedOn, evidence: method.evidence }
							])
							if (method.reference)
								yield* draft.insert(S.DigitalReference, [
									{ submission, version: version.id, filing: version.filing, ...method.reference }
								])
							break
						}
						case "CertifiedMail":
							yield* draft.insert(S.CertifiedMailSubmission, [
								{ submission, version: version.id, business, mailing: method.mailing }
							])
							break
					}
					yield* draft.insert(S.SubmissionDocument, manifest)
					return { filing: version.filing, version: version.id, submission }
				})
		})
	})

export const FilingRejectInput = Schema.Struct({
	...common,
	...inputFields(S.Rejection, ["submission", "evidence"])
})
export const rejectFiling = (payload: unknown) =>
	Effect.gen(function* () {
		const input = parseStrict(FilingRejectInput, payload),
			business = input.business
		return yield* businessCommand({
			request: input.request,
			business,
			action: "filings reject",
			input: payload,
			plan: ({ snapshot, draft, recordedAt }) =>
				Effect.gen(function* () {
					const submission = (yield* relationRows(snapshot, S.Submission)).find(
						(row) => row.id === input.submission && row.business === business
					)
					if (!submission)
						return yield* Effect.fail(
							new Refusal({
								code: "SubmissionMissing",
								message: `No matching submission ${input.submission}`
							})
						)
					if (!(yield* relationRows(snapshot, S.Rejection)).some((row) => row.submission === submission.id))
						yield* draft.insert(S.Rejection, [
							{ submission: submission.id, evidence: input.evidence, recordedAt }
						])
					return { submission: submission.id, version: submission.version }
				})
		})
	})

export const FilingDeadlineInput = Schema.Struct({
	...common,
	...inputFields(S.DeadlineRevision, ["filing", "dueOn", "evidence"], { dueOn: Day })
})
export const reviseDeadline = (payload: unknown) =>
	Effect.gen(function* () {
		const input = parseStrict(FilingDeadlineInput, payload),
			business = input.business
		return yield* businessCommand({
			request: input.request,
			business,
			action: "filings deadline",
			input: payload,
			plan: ({ snapshot, draft, recordedAt }) =>
				Effect.gen(function* () {
					const filing = (yield* relationRows(snapshot, S.Filing)).find(
						(row) => row.id === input.filing && row.business === business
					)
					if (!filing)
						return yield* Effect.fail(
							new Refusal({ code: "FilingMissing", message: `No matching filing ${input.filing}` })
						)
					const sequence =
						(yield* relationRows(snapshot, S.DeadlineRevision))
							.filter((row) => row.filing === filing.id)
							.reduce((largest, row) => (row.sequence > largest ? row.sequence : largest), 0n) + 1n
					const deadline = yield* mintId
					yield* draft.insert(S.DeadlineRevision, [
						{
							id: deadline,
							filing: filing.id,
							sequence,
							dueOn: input.dueOn,
							evidence: input.evidence,
							recordedAt
						}
					])
					return { filing: filing.id, deadline }
				})
		})
	})

export const FilingAmendInput = Schema.Struct({
	...common,
	...inputFields(S.CorrectionFiling, ["parent", "evidence"]),
	discoveredOn: Day,
	dueOn: Day,
	revisions: Schema.Array(Id)
})

/** A correction is another filing, even when its tax difference is zero.
 * The supplied revisions attribute its changed assessments; preparation later
 * captures the entire current return basis under the same scope proof.
 */
export const amendFiling = (payload: unknown) =>
	Effect.gen(function* () {
		const input = parseStrict(FilingAmendInput, payload),
			business = input.business
		return yield* businessCommand({
			request: input.request,
			business,
			action: "filings amend",
			input: payload,
			plan: ({ snapshot, draft, recordingDay }) =>
				Effect.gen(function* () {
					const parent = (yield* relationRows(snapshot, S.Filing)).find(
						(row) => row.id === input.parent && row.business === business
					)
					if (!parent)
						return yield* Effect.fail(
							new Refusal({ code: "FilingMissing", message: `No matching parent ${input.parent}` })
						)
					const child = (yield* relationRows(snapshot, S.CorrectionFiling)).find(
						(row) => row.parent === parent.id
					)
					if (child)
						return yield* Effect.fail(
							new Refusal({
								code: "CorrectionExists",
								message: `Continue the existing correction ${child.filing}`
							})
						)
					const register = yield* workRegister(snapshot, business, recordingDay)
					if (!register.work.some((row) => row.id === parent.id && row.completion === "Complete"))
						return yield* Effect.fail(
							new Refusal({
								code: "ParentNotSubmitted",
								message: "Prepare or resubmit the existing filing before creating another correction"
							})
						)
					const discoveredOn = input.discoveredOn
					if (discoveredOn > recordingDay)
						return yield* Effect.fail(
							new Refusal({
								code: "FutureDiscovery",
								message: "A correction's discovery date cannot be in the future"
							})
						)
					const revisions = yield* rows(snapshot, currentRevisions, {})
					const accounts = yield* relationRows(snapshot, S.RevisionAccount)
					const selected = input.revisions.map((id) => {
						const revision = revisions.find((row) => row.id === id && row.business === business)
						if (!revision)
							throw new Refusal({
								code: "RevisionNotCurrent",
								message: `Select the current assessment revision for ${id}`
							})
						return revision
					})
					const filing = yield* createCorrectionFacts(snapshot, draft, {
						parent,
						discoveredOn,
						dueOn: input.dueOn,
						evidence: input.evidence,
						selected,
						accounts
					})
					return { filing: filing.id, parent: parent.id }
				})
		})
	})

const createCorrectionFacts = (
	snapshot: Snapshot,
	draft: Draft,
	options: {
		parent: Fact<typeof S.Filing>
		discoveredOn: UnixEpochDay
		dueOn: UnixEpochDay
		evidence: string
		selected: readonly Fact<typeof S.AssessmentRevision>[]
		accounts: readonly Fact<typeof S.RevisionAccount>[]
	}
) =>
	Effect.gen(function* () {
		const { parent, discoveredOn, dueOn, evidence, selected, accounts } = options,
			business = parent.business
		const form = formPolicy[parent.form].correction
		const previousRequirement = (yield* relationRows(snapshot, S.FilingRequirement)).find(
			(row) => row.business === business && row.form === form
		)
		const requirement = previousRequirement?.id ?? (yield* mintId)
		if (!previousRequirement)
			yield* draft.insert(S.FilingRequirement, [
				{
					id: requirement,
					business,
					form,
					subjectKind: formPolicy[form].subject,
					startsOn: discoveredOn,
					evidence: evidence
				}
			])
		const filing: Fact<typeof S.Filing> = {
			id: yield* mintId,
			business,
			requirement,
			subject: parent.subject,
			form,
			period: parent.period,
			kind: "Correction",
			opensOn: discoveredOn,
			dueOn: dueOn,
			evidence: evidence
		}
		yield* draft.insert(S.Filing, [filing])
		yield* draft.insert(S.CorrectionFiling, [
			{
				filing: filing.id,
				parent: parent.id,
				form,
				parentForm: parent.form,
				business,
				subject: parent.subject,
				period: parent.period,
				evidence: evidence
			}
		])
		yield* draft.insert(
			S.FilingRevision,
			selected.map((revision) => filingRevision(filing, revision))
		)
		if (formPolicy[form].payment) {
			for (const revision of selected) {
				const account = accounts.find(
					(row) => row.revision === revision.id && row.family === formPolicy[form].family
				)
				if (!account)
					return yield* Effect.fail(
						new Refusal({
							code: "RevisionAccountMissing",
							message: "The correction has no matching liability account"
						})
					)
				yield* draft.insert(S.AmendmentLiability, [
					{
						filing: filing.id,
						revision: revision.id,
						account: account.account,
						business,
						family: account.family,
						evidence: evidence
					}
				])
			}
		}
		return filing
	})

export const AmendmentDeadlineInput = Schema.Struct({
	...inputFields(S.CorrectionFiling, ["parent", "evidence"]),
	dueOn: Day
})

/** Used by tax revision in its own atomic draft. Submitted snapshots require a
 * new correction; an open correction receives the new revision. Due dates for
 * new corrections come from explicit evidence, never a made-up grace period.
 */
export const revisionFilingFacts = (
	snapshot: Snapshot,
	draft: Draft,
	options: {
		revision: Fact<typeof S.AssessmentRevision>
		accounts: readonly Fact<typeof S.RevisionAccount>[]
		recordingDay: UnixEpochDay
		evidence: string
		deadlines: readonly (typeof AmendmentDeadlineInput.Type)[]
	}
) =>
	Effect.gen(function* () {
		const { revision, accounts, recordingDay, evidence } = options,
			business = revision.business
		const allFilings = (yield* relationRows(snapshot, S.Filing)).filter((row) => row.business === business)
		const children = yield* relationRows(snapshot, S.CorrectionFiling)
		const employeeSubjects = yield* relationRows(snapshot, S.EmployeeSubject)
		const register = yield* workRegister(snapshot, business, recordingDay)
		const affected = allFilings.filter(
			(row) =>
				row.period.start <= revision.paidOn.start &&
				row.period.end >= revision.paidOn.end &&
				!children.some((child) => child.parent === row.id) &&
				(formPolicy[row.form].subject === "Business" ||
					employeeSubjects.some(
						(subject) => subject.subject === row.subject && subject.employee === revision.employee
					))
		)
		const submitted = affected.filter((row) =>
			register.work.some((item) => item.id === row.id && item.completion === "Complete")
		)
		if (
			new Set(options.deadlines.map((row) => row.parent)).size !== options.deadlines.length ||
			options.deadlines.some((row) => !submitted.some((parent) => parent.id === row.parent))
		)
			return yield* Effect.fail(
				new Refusal({
					code: "CorrectionDeadlineScope",
					message: "Supply one deadline for each affected submitted parent only"
				})
			)
		const missing = submitted.filter((parent) => !options.deadlines.some((row) => row.parent === parent.id))
		if (missing.length)
			return yield* Effect.fail(
				new Refusal({
					code: "CorrectionDeadlineRequired",
					message: json({
						action: "Supply evidenced amendment deadlines in payroll revise-tax",
						parents: missing.map((row) => ({ filing: row.id, form: row.form, period: row.period }))
					})
				})
			)
		const linked: Uuid[] = []
		for (const parent of submitted) {
			const deadline = options.deadlines.find((row) => row.parent === parent.id)
			if (!deadline)
				return yield* Effect.fail(
					new Refusal({ code: "CorrectionDeadlineRequired", message: "Missing correction deadline" })
				)
			const filing = yield* createCorrectionFacts(snapshot, draft, {
				parent,
				discoveredOn: recordingDay,
				dueOn: deadline.dueOn,
				evidence: deadline.evidence,
				selected: [revision],
				accounts
			})
			linked.push(filing.id)
		}
		for (const filing of affected.filter(
			(row) => row.kind === "Correction" && !submitted.some((parent) => parent.id === row.id)
		)) {
			yield* draft.insert(S.FilingRevision, [filingRevision(filing, revision)])
			if (formPolicy[filing.form].payment) {
				const account = accounts.find((row) => row.family === formPolicy[filing.form].family)
				if (!account)
					return yield* Effect.fail(
						new Refusal({
							code: "RevisionAccountMissing",
							message: "The correction has no matching liability account"
						})
					)
				yield* draft.insert(S.AmendmentLiability, [
					{
						filing: filing.id,
						revision: revision.id,
						account: account.account,
						business,
						family: account.family,
						evidence
					}
				])
			}
			linked.push(filing.id)
		}
		return linked
	})

/** Evidence inspection consumes the same completion register as payroll. */
export const inspectFilings = (snapshot: Snapshot, business: Uuid, asOf: UnixEpochDay) =>
	Effect.gen(function* () {
		const ownFilings = (yield* relationRows(snapshot, S.Filing)).filter((row) => row.business === business)
		const ownVersions = (yield* relationRows(snapshot, S.FilingVersion)).filter(
			(row) => row.business === business
		)
		const ownSubmissions = (yield* relationRows(snapshot, S.Submission)).filter(
			(row) => row.business === business
		)
		const filingIds = new Set(ownFilings.map((row) => row.id)),
			versionIds = new Set(ownVersions.map((row) => row.id)),
			submissionIds = new Set(ownSubmissions.map((row) => row.id))
		const ownDocuments = (yield* relationRows(snapshot, S.FilingDocument)).filter((row) =>
			versionIds.has(row.version)
		)
		const mailingLinks = (yield* relationRows(snapshot, S.CertifiedMailSubmission)).filter((row) =>
			submissionIds.has(row.submission)
		)
		const mailingIds = new Set(mailingLinks.map((row) => row.mailing))
		const mailings = (yield* relationRows(snapshot, S.CertifiedMailing)).filter((row) =>
			mailingIds.has(row.id)
		)
		const mailingEvidence = (yield* relationRows(snapshot, S.MailingEvidence)).filter((row) =>
			mailingIds.has(row.mailing)
		)
		const artifactIds = new Set([
			...ownDocuments.map((row) => row.artifact),
			...mailings.map((row) => row.receipt),
			...mailingEvidence.map((row) => row.artifact)
		])
		return {
			register: yield* workRegister(snapshot, business, asOf),
			filings: ownFilings,
			versions: ownVersions,
			documents: ownDocuments,
			submissions: ownSubmissions,
			corrections: (yield* relationRows(snapshot, S.CorrectionFiling)).filter((row) =>
				filingIds.has(row.filing)
			),
			rejections: (yield* relationRows(snapshot, S.Rejection)).filter((row) =>
				submissionIds.has(row.submission)
			),
			digital: (yield* relationRows(snapshot, S.DigitalSubmission)).filter((row) =>
				submissionIds.has(row.submission)
			),
			digitalReferences: (yield* relationRows(snapshot, S.DigitalReference)).filter((row) =>
				submissionIds.has(row.submission)
			),
			grandfathered: (yield* relationRows(snapshot, S.GrandfatheredSubmission)).filter((row) =>
				submissionIds.has(row.submission)
			),
			mailingLinks,
			mailings,
			mailingEvidence,
			artifacts: (yield* relationRows(snapshot, S.Artifact)).filter((row) => artifactIds.has(row.id)),
			locations: (yield* relationRows(snapshot, S.ArtifactLocation)).filter((row) =>
				artifactIds.has(row.artifact)
			)
		}
	})
