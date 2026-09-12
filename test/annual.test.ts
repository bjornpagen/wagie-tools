import assert from "node:assert/strict"
import * as path from "node:path"
import { test } from "node:test"
import { ChangeSet } from "@bjornpagen/bumbledb"
import { Effect } from "effect"
import { epochDay, formatCalendarDate, parseCalendarDate, periodSpan } from "../src/core/time.ts"
import { MAX_U64, mintId } from "../src/core/values.ts"
import {
	annualPolicyData,
	approvedPoliciesAt,
	recordAnnualEvidence,
	recordAnnualPolicy,
	recordElectionDocument,
	refreshPolicy
} from "../src/policy/annual.ts"
import { inspectProfiles } from "../src/profiles.ts"
import { relationRows } from "../src/queries.ts"
import { report } from "../src/reports.ts"
import { Ledger, latest } from "../src/runtime.ts"
import { annualRequirements } from "../src/schema/vocabulary.ts"
import * as S from "../src/schema.ts"
import { workRegister } from "../src/work.ts"
import { resultId as id, assertRefusal as refusal } from "./assertions.ts"
import { apply, atTime, withHistory } from "./native-history.ts"
import { setupPayroll } from "./payroll-fixture.ts"

const evidence = "Synthetic annual refresh qualification"

test("annual policy stores verified public data without employer defaults and requires both independently refreshed jurisdictions", async () => {
	await withHistory((history, binding, directory) =>
		atTime(
			Date.parse("2026-09-11T17:00:00Z"),
			Effect.gen(function* () {
				const fixture = yield* setupPayroll(history),
					{ business, release } = fixture
				const draft = yield* ChangeSet.builder(S.ledger)
				yield* draft.delete(S.AnnualApproval, fixture.annual.policies)
				yield* draft.insert(S.PolicyBinding, [{ business, release, evidence }])
				assert.equal((yield* apply(history, yield* draft.finish())).outcome.kind, "committed")
				const day = parseCalendarDate("2026-09-11")
				refusal(
					yield* Effect.result(approvedPoliciesAt(yield* latest, business, release, day)),
					"AnnualPolicyRefreshRequired"
				)
				const source = yield* annualPolicyData(yield* latest, business)
				for (const policy of source.policies) {
					const input = {
						request: yield* mintId,
						business,
						release,
						authority: policy.authority,
						year: 2026,
						evidence,
						sources: [{ artifact: fixture.annual.artifact, evidence }],
						rates: source.rates
							.filter((row) => row.annual === policy.id)
							.map((row) => ({
								kind: row.kind,
								artifact: row.artifact,
								evidence,
								denominator: "10000",
								bands: source.bands
									.filter((b) => b.schedule === row.schedule)
									.map((b) => ({
										start: String(b.span.start),
										end: b.span.end === MAX_U64 ? "Infinity" : String(b.span.end),
										numerator: String(b.numerator),
										role: b.role
									}))
							})),
						limits: source.limits
							.filter((row) => row.annual === policy.id)
							.map((row) => ({ kind: row.kind, cents: String(row.cents), artifact: row.artifact, evidence })),
						...(policy.authority === "FederalDC"
							? {
									lookback: {
										start: "2024-07-01",
										endExclusive: "2025-07-01",
										artifact: fixture.annual.artifact,
										evidence
									}
								}
							: {})
					}
					const receipt = yield* recordAnnualPolicy(input),
						annual = id(receipt, "annual")
					assert.deepEqual(yield* recordAnnualPolicy(input), receipt)
					const refresh = { request: yield* mintId, business, release, annual, evidence }
					refusal(yield* Effect.result(refreshPolicy(refresh)), "AnnualPolicyIncomplete")
					for (const kind of annualRequirements[policy.authority].evidence)
						yield* recordAnnualEvidence({
							request: yield* mintId,
							business,
							annual,
							kind,
							artifact: fixture.annual.artifact,
							evidence
						})
					yield* refreshPolicy({ ...refresh, request: yield* mintId })
					const data = yield* annualPolicyData(yield* latest, business)
					assert.equal(data.approvals.length, policy.authority === source.policies[0]?.authority ? 1 : 2)
					if (data.approvals.length === 1)
						refusal(
							yield* Effect.result(approvedPoliciesAt(yield* latest, business, release, day)),
							"AnnualPolicyRefreshRequired"
						)
				}
				assert.equal(
					(yield* approvedPoliciesAt(yield* latest, business, release, parseCalendarDate("2026-12-31")))
						.length,
					2
				)
				refusal(
					yield* Effect.result(
						approvedPoliciesAt(yield* latest, business, release, parseCalendarDate("2027-01-01"))
					),
					"AnnualPolicyRefreshRequired"
				)
				const current = yield* workRegister(yield* latest, business, day)
				assert.equal(current.blockers.filter((row) => row.kind === "PolicyRefresh").length, 0)
				assert.equal(
					current.work.filter((row) => row.kind === "PolicyRefresh" && row.completion === "Open").length,
					2
				)
				const next = yield* workRegister(yield* latest, business, parseCalendarDate("2027-01-01"))
				assert.equal(next.blockers.filter((row) => row.kind === "PolicyRefresh").length, 2)
				const reported = yield* report(yield* latest, business, 2026, undefined, day)
				assert.deepEqual(reported.register, current)
				const invalid = yield* ChangeSet.builder(S.ledger),
					annual = yield* mintId
				const original = source.policies[0]
				assert.ok(original)
				yield* invalid.insert(S.AnnualPolicy, [
					{
						...original,
						id: annual,
						valid: { start: original.valid.start, end: periodSpan(2027, "Year").end }
					}
				])
				yield* invalid.insert(S.AnnualSource, [{ annual, artifact: fixture.annual.artifact, evidence }])
				assert.equal((yield* apply(history, yield* invalid.finish())).outcome.kind, "invariant-rejected")
				assert.equal(formatCalendarDate(epochDay(original.valid.end)), "2027-01-01")
			}).pipe(
				Effect.provideService(Ledger, {
					history,
					binding,
					recoveryDirectory: path.join(directory, "requests")
				})
			)
		)
	)
})

test("updated election documents explicitly replace the current document without authorizing or resending money", async () => {
	await withHistory((history, binding, directory) =>
		atTime(
			Date.parse("2026-09-11T17:00:00Z"),
			Effect.gen(function* () {
				const { business, employee, annual } = yield* setupPayroll(history)
				const input = {
					request: yield* mintId,
					business,
					employee,
					year: 2026,
					signedOn: "2026-09-09",
					artifact: annual.artifact,
					evidence,
					amounts: { Roth: "1000", Traditional: "0", OptionalAfterTax: "2000", EmployerProfitSharing: "0" }
				}
				const predecessor = id(yield* recordElectionDocument(input), "document")
				const nextArtifact = yield* mintId,
					draft = yield* ChangeSet.builder(S.ledger)
				yield* draft.insert(S.Artifact, [
					{ id: nextArtifact, sha256: "synthetic-replacement", mediaType: "text/plain" }
				])
				yield* draft.insert(S.VerifiedArtifact, [{ artifact: nextArtifact, length: 2n, verifiedAt: 0n }])
				assert.equal((yield* apply(history, yield* draft.finish())).outcome.kind, "committed")
				const replacement = {
					...input,
					request: yield* mintId,
					signedOn: "2026-09-10",
					artifact: nextArtifact,
					amounts: { ...input.amounts, Roth: "3000" }
				}
				refusal(yield* Effect.result(recordElectionDocument(replacement)), "ElectionPredecessorRequired")
				const receipt = yield* recordElectionDocument({
					...replacement,
					request: yield* mintId,
					supersedes: predecessor
				})
				const profiles = yield* inspectProfiles(yield* latest, business)
				assert.equal(profiles.electionDocuments.length, 2)
				assert.deepEqual(
					profiles.currentElectionDocuments.map((row) => row.id),
					[id(receipt, "document")]
				)
				assert.equal(profiles.currentElectionDocuments[0]?.signedOn, parseCalendarDate("2026-09-10"))
				assert.equal((yield* relationRows(yield* latest, S.Election)).length, 0)
				assert.equal((yield* relationRows(yield* latest, S.BankMovement)).length, 0)
			}).pipe(
				Effect.provideService(Ledger, {
					history,
					binding,
					recoveryDirectory: path.join(directory, "requests")
				})
			)
		)
	)
})
