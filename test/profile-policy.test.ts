import assert from "node:assert/strict"
import * as path from "node:path"
import { test } from "node:test"
import { ChangeSet } from "@bjornpagen/bumbledb"
import { Effect } from "effect"
import { civilDaySpan, parseCalendarDate, periodSpan } from "../src/core/time.ts"
import { mintId } from "../src/core/values.ts"
import { ensureFilings } from "../src/filing-coverage.ts"
import { calculatePayroll, inspectCalculation } from "../src/payroll.ts"
import { activatePolicy, installPolicy } from "../src/policy/install.ts"
import { configureBusiness, recordBudget, recordElection, recordEmployee } from "../src/profiles.ts"
import { Ledger, latest } from "../src/runtime.ts"
import { formPolicy, forms } from "../src/schema/vocabulary.ts"
import * as S from "../src/schema.ts"
import { suggestGross } from "../src/suggestions.ts"
import { workRegister } from "../src/work.ts"
import { seedAnnualPolicies } from "./annual-fixture.ts"
import { resultId as id, refusalCode as refusal } from "./assertions.ts"
import { apply, atTime, withHistory } from "./native-history.ts"

const evidence = "Synthetic full command qualification; not legal policy evidence"
const year = { start: "2026-01-01", endExclusive: "2027-01-01" }

test("public setup installs immutable policies and records signed elections", async () => {
	await withHistory((history, binding, directory) =>
		atTime(
			Date.parse("2026-09-11T17:00:00Z"),
			Effect.gen(function* () {
				const business = id(
					yield* configureBusiness({
						request: yield* mintId,
						name: "Synthetic company",
						ein: "00-0000077",
						state: "TX",
						timeZone: "America/Chicago",
						addresses: [],
						evidence
					}),
					"business"
				)
				const employee = id(
					yield* recordEmployee({
						request: yield* mintId,
						business,
						firstName: "Synthetic",
						lastName: "Employee",
						ssn: "000-00-0001",
						address: "Test address",
						filingStatus: "Single",
						evidence
					}),
					"employee"
				)
				yield* recordBudget({
					request: yield* mintId,
					business,
					employee,
					year: 2026,
					limit: "2000000",
					evidence
				})
				const policyInput = {
					request: yield* mintId,
					business,
					title: evidence,
					evidence,
					calendars: S.Authority.handles.map((authority) => ({
						authority,
						fromYear: 2026,
						throughYear: 2027,
						holidays: [],
						evidence
					})),
					filingRules: forms
						.filter((form) => formPolicy[form].due !== "RecordedEvent")
						.map((form) => ({ form, dueRule: "FollowingMonthEnd", evidence })),
					deposits: S.AccountFamily.handles.map((family) => ({
						family,
						valid: year,
						periodKind: family === "Federal941" ? "Month" : "Quarter",
						authority: family === "TexasUnemployment" ? "Texas" : "FederalDC",
						dueRule: family === "Federal941" ? "FollowingMonth15" : "FollowingMonthEnd",
						triggers: {
							Interim: { start: family === "Federal940" ? "50001" : "1", end: "Infinity" },
							Terminal: { start: "1", end: "Infinity" }
						},
						evidence
					})),
					payroll: {
						valid: year,
						federalDepositLimit: "10000000",
						evidence,
						programs: ["SocialSecurity", "Medicare", "FederalUnemployment", "StateUnemployment"].map(
							(program) => ({
								program,
								eligible: { start: "0", end: program === "Medicare" ? "20000000" : "Infinity" },
								evidence
							})
						),
						rates: [
							{ component: "EmployeeSS", cap: "18450000", numerator: "620" },
							{ component: "EmployerSS", cap: "18450000", numerator: "620" },
							{ component: "EmployeeMedicare", cap: "Infinity", numerator: "145" },
							{ component: "EmployerMedicare", cap: "Infinity", numerator: "145" },
							{ component: "FUTA", cap: "700000", numerator: "60", futaBasis: evidence },
							{ component: "SUTA", cap: "900000", numerator: "270", employerNotice: evidence }
						].map(({ component, cap, numerator, ...basis }) => ({
							component,
							valid: year,
							denominator: "10000",
							bands: [
								{ start: "0", end: cap, numerator, role: "WithinBase" },
								...(cap === "Infinity"
									? []
									: [{ start: cap, end: "Infinity", numerator: "0", role: "Excess" }])
							],
							evidence,
							...basis
						})),
						deferrals: [{ year: 2026, limit: "2400000", evidence }],
						monthlyDepositor: { valid: year, evidence },
						grossSuggestion: { method: "RemainingBudgetDays", evidence }
					}
				}
				const installed = yield* installPolicy(policyInput),
					release = id(installed, "release")
				assert.equal(id(yield* installPolicy({ ...policyInput, request: yield* mintId }), "release"), release)
				yield* seedAnnualPolicies(history, business, release)
				yield* activatePolicy({ request: yield* mintId, business, release, evidence })
				yield* ensureFilings({
					request: yield* mintId,
					business,
					throughYear: 2026,
					enrollment: { startsOn: "2026-09-01", evidence }
				})
				assert.deepEqual(
					(yield* workRegister(yield* latest, business, parseCalendarDate("2026-09-11"))).blockers,
					[]
				)
				const calculationInput = {
					request: yield* mintId,
					business,
					employee,
					purpose: {
						kind: "NewWage",
						paidOn: "2026-09-11",
						grossCents: "100000",
						rothCents: "0",
						work: { start: "2026-09-01", endExclusive: "2026-09-11" }
					},
					fit: { cents: "0", evidence },
					evidence
				}
				const suggestion = yield* suggestGross(
					yield* latest,
					business,
					employee,
					civilDaySpan(parseCalendarDate("2026-09-01"), parseCalendarDate("2026-09-11")),
					parseCalendarDate("2026-09-11"),
					parseCalendarDate("2026-09-11")
				)
				assert.equal(suggestion.workDays, 10n)
				assert.equal(suggestion.remainingDays, 122n)
				assert.equal(suggestion.gross, 163934n)
				const original = id(yield* calculatePayroll(calculationInput), "calculation")
				const prior = yield* inspectCalculation(yield* latest, business, original)
				assert.equal(prior.amounts.find((row) => row.component === "SUTA")?.amount, 2700n)
				const changed = {
					...policyInput,
					request: yield* mintId,
					title: "Changed synthetic employer rate",
					payroll: {
						...policyInput.payroll,
						rates: policyInput.payroll.rates.map((rate) =>
							rate.component === "SUTA"
								? {
										...rate,
										employerNotice: "Different synthetic notice",
										bands: rate.bands.map((band) => ({ ...band, numerator: "0" }))
									}
								: rate
						)
					}
				}
				const replacement = id(yield* installPolicy(changed), "release")
				yield* seedAnnualPolicies(history, business, replacement)
				yield* activatePolicy({ request: yield* mintId, business, release: replacement, evidence })
				const old = yield* inspectCalculation(yield* latest, business, original)
				assert.deepEqual(old.amounts, prior.amounts, "activation cannot reprice a saved calculation")
				const next = id(
					yield* calculatePayroll({ ...calculationInput, request: yield* mintId }),
					"calculation"
				)
				const newFigures = yield* inspectCalculation(yield* latest, business, next)
				assert.equal(newFigures.amounts.find((row) => row.component === "SUTA")?.amount, 0n)
				assert.equal(newFigures.taxableWages.find((row) => row.component === "SUTA")?.amount, 100000n)
				const bad = {
					...changed,
					request: yield* mintId,
					title: "Missing credit basis",
					payroll: {
						...changed.payroll,
						rates: changed.payroll.rates.map((rate) => {
							const { futaBasis, ...rest } = rate
							return rest
						})
					}
				}
				assert.equal(refusal(yield* Effect.result(installPolicy(bad))), "invariant-rejected")
				for (const [omission, expected] of [
					["forms", "FilingPolicyIncomplete"],
					["rates", "PayrollPolicyIncomplete"]
				] as const) {
					const incomplete = id(
						yield* installPolicy({
							...changed,
							request: yield* mintId,
							title: `Synthetic missing ${omission}`,
							...(omission === "forms"
								? { filingRules: changed.filingRules.slice(1) }
								: {
										payroll: {
											...changed.payroll,
											rates: changed.payroll.rates.filter((row) => row.component !== "FUTA")
										}
									})
						}),
						"release"
					)
					assert.equal(
						refusal(
							yield* Effect.result(
								activatePolicy({ request: yield* mintId, business, release: incomplete, evidence })
							)
						),
						expected
					)
				}

				const document = yield* mintId,
					artifact = yield* mintId,
					plan = yield* mintId
				const electionSetup = yield* ChangeSet.builder(S.ledger)
				yield* electionSetup.insert(S.Owner, [{ business, employee, evidence }])
				yield* electionSetup.insert(S.RetirementPlan, [
					{
						id: plan,
						business,
						employee,
						name: "Synthetic Plan",
						ein: "00-0000020",
						evidence,
						recordedAt: 0n
					}
				])
				yield* electionSetup.insert(S.RetirementAnnual, [
					{
						id: yield* mintId,
						plan,
						employee,
						year: 2026n,
						valid: periodSpan(2026, "Year"),
						deferralLimit: 2400000n,
						additionsLimit: 7000000n,
						compensationCap: 35000000n,
						outsideDeferrals: 0n,
						outsideAdditions: 0n,
						otherPlans: false,
						outsideAssets: false,
						evidence,
						recordedAt: 0n
					}
				])
				yield* electionSetup.insert(S.Artifact, [
					{ id: artifact, sha256: "synthetic-signed-election", mediaType: "text/plain" }
				])
				yield* electionSetup.insert(S.VerifiedArtifact, [{ artifact, length: 1n, verifiedAt: 0n }])
				yield* electionSetup.insert(S.ElectionDocument, [
					{
						id: document,
						employee,
						year: 2026n,
						signedOn: parseCalendarDate("2026-09-11"),
						artifact,
						evidence,
						recordedAt: 0n
					}
				])
				yield* electionSetup.insert(
					S.ElectionDocumentAmount,
					S.ElectionContributionKind.handles.map((kind) => ({
						document,
						kind,
						cents: kind === "Roth" ? 1900000n : 0n
					}))
				)
				assert.equal((yield* apply(history, yield* electionSetup.finish())).outcome.kind, "committed")
				assert.equal(
					refusal(
						yield* Effect.result(
							recordElection({ request: yield* mintId, business, document, effectiveOn: "2026-09-10" })
						)
					),
					"ElectionDate"
				)
				yield* recordElection({ request: yield* mintId, business, document, effectiveOn: "2026-09-11" })

				assert.ok(
					!(yield* workRegister(yield* latest, business, parseCalendarDate("2026-09-11"))).readiness.some(
						(row) => row.kind === "ElectionMissing"
					)
				)
			})
		).pipe(
			Effect.provideService(Ledger, { history, binding, recoveryDirectory: path.join(directory, "requests") })
		)
	)
})
