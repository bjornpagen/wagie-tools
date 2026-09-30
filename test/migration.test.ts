import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { ChangeSet, NativeRuntime, query, Schema, type Uuid, v } from "@bjornpagen/bumbledb"
import {
	Command,
	DatabaseId,
	IncarnationId,
	type LocalBinding,
	LocalHistory,
	OperationId,
	type PublishedSnapshot,
	RequestId,
	Transition
} from "@bjornpagen/bumbledb-log"
import { Effect, Result } from "effect"
import * as s0000 from "../migrations/0000-initial/schema.ts"
import * as s0001 from "../migrations/0001-statements/schema.ts"
import { type AnySchema, type Step, steps } from "../migrations/index.ts"
import { filingDigestOf } from "../src/bookkeeping.ts"
import { statementId } from "../src/commands.ts"
import { io, readBytes } from "../src/core/files.ts"
import { parseCalendarDate } from "../src/core/time.ts"
import { mintId } from "../src/core/values.ts"
import { relationRows, select } from "../src/queries.ts"
import * as S from "../src/schema.ts"
import { workRegister } from "../src/work.ts"
import { apply } from "./native-history.ts"

const oldSnapshot = fileURLToPath(new URL("../migrations/0000-initial/schema.json", import.meta.url))

/** Creates a 0000 history with a small synthetic ledger holding every shape
 * the transformations must carry: prose evidence, a Drive-verified location
 * with prior locations, all four question families, a timestamped approval
 * without an id, a TaxBand span, supplied 1099-R/1096 report blobs, payment
 * and bank references, and attestations. */
const seedOld = (directory: string) =>
	Effect.gen(function* () {
		const compiled = yield* Schema.compile(s0000.schema)
		const binding = {
			kind: "local" as const,
			directory,
			identity: {
				databaseId: Result.getOrThrow(DatabaseId.from(yield* mintId)),
				incarnationId: Result.getOrThrow(IncarnationId.from(yield* mintId)),
				schemaId: compiled.schemaId
			}
		}
		const history = yield* LocalHistory.create(binding, s0000.schema, {
			creation: {
				operationId: Result.getOrThrow(OperationId.from(yield* mintId)),
				artifact: yield* readBytes(oldSnapshot)
			}
		})
		const business = yield* mintId,
			employee = yield* mintId,
			plan = yield* mintId,
			artifact = yield* mintId,
			review = yield* mintId,
			setup = yield* mintId,
			bookkeeping = yield* mintId,
			financial = yield* mintId,
			account = yield* mintId,
			release = yield* mintId,
			schedule = yield* mintId,
			band = yield* mintId,
			planAccount = yield* mintId,
			report1099 = yield* mintId,
			report1096 = yield* mintId,
			payment = yield* mintId,
			movement = yield* mintId
		const R = s0000.schema.relations
		const draft = yield* ChangeSet.builder(s0000.schema)
		yield* draft.insert(R.Business, [
			{ id: business, name: "Synthetic", ein: "00-0000123", state: "TX", timeZone: "UTC", recordedAt: 1n }
		])
		yield* draft.insert(R.BusinessAddress, [
			{
				business,
				kind: "Business",
				street: "1 Main",
				city: "Austin",
				state: "TX",
				zip: "78701",
				country: "USA"
			}
		])
		yield* draft.insert(R.Employee, [
			{
				id: employee,
				business,
				firstName: "A",
				lastName: "B",
				ssn: "000-00-0000",
				address: "x",
				filingStatus: "Single",
				recordedAt: 2n
			}
		])
		yield* draft.insert(R.TaxAccount, [
			{ id: account, business, family: "Federal941", evidence: "shared prose" }
		])
		yield* draft.insert(R.Owner, [{ business, employee, evidence: "shared prose" }])
		yield* draft.insert(R.RetirementPlan, [
			{
				id: plan,
				business,
				employee,
				name: "Plan",
				ein: "99-0000000",
				evidence: "plan prose",
				recordedAt: 3n
			}
		])
		yield* draft.insert(R.PlanAccount, [
			{ id: planAccount, plan, kind: "Roth", provider: "Carry", reference: "acct-1", evidence: "plan prose" }
		])
		yield* draft.insert(R.Artifact, [{ id: artifact, sha256: "a".repeat(64), mediaType: "application/pdf" }])
		yield* draft.insert(R.VerifiedArtifact, [{ artifact, length: 10n, verifiedAt: 4n }])
		yield* draft.insert(R.ArtifactLocation, [
			{
				artifact,
				locator: "https://drive.google.com/file/d/abcdefghijklmnop/view",
				evidence: JSON.stringify({
					kind: "VerifiedDriveArtifact",
					remote: "gdrive:",
					sha256: "a".repeat(64),
					length: "10",
					verifiedAt: "4",
					evidence: "archived to Drive",
					previousLocations: [
						{ artifact, locator: "file:///old/copy.pdf", evidence: "local copy" },
						{ artifact, locator: "file:///old/copy.pdf", evidence: "local copy" },
						{ artifact, locator: "file:///older/copy.pdf", evidence: "older copy" }
					]
				})
			}
		])
		yield* draft.insert(R.RetirementReport, [
			{
				id: report1099,
				plan,
				year: 2025n,
				artifact,
				supplied: JSON.stringify({
					form: "1099-R",
					account: planAccount,
					grossCents: 4296408,
					taxableCents: 0,
					box5Cents: 4296408,
					distributionCode: "H",
					kind: "Roth",
					eventDayNotSupplied: true
				}),
				evidence: "report prose",
				recordedAt: 10n
			},
			{
				id: report1096,
				plan,
				year: 2025n,
				artifact,
				supplied: JSON.stringify({ form: "1096", formCount: 3, grossCents: 9421153 }),
				evidence: "report prose",
				recordedAt: 11n
			}
		])
		yield* draft.insert(R.TaxPayment, [
			{ id: payment, business, account, sentOn: 20300n, amount: 100n, evidence: "paid", recordedAt: 12n }
		])
		yield* draft.insert(R.PaymentReference, [
			{ payment, issuer: "EFTPS", scope: account, value: "270556782874987", sourceText: "270556782874987" }
		])
		yield* draft.insert(R.BankMovement, [
			{
				id: movement,
				business,
				direction: "Outflow",
				paidOn: 20300n,
				amount: 100n,
				evidence: "bank",
				recordedAt: 13n
			}
		])
		yield* draft.insert(R.MercuryTransaction, [{ movement, reference: "MERC1" }])
		yield* draft.insert(R.BankReference, [
			{ movement, issuer: "Mercury", scope: business, value: "MERC1", sourceText: "MERC1" }
		])
		yield* draft.insert(R.Review, [{ id: review, employee, year: 2026n, topic: "fit", detail: "check FIT" }])
		yield* draft.insert(R.RetirementSetup, [
			{ id: setup, plan, detail: "convert legacy balance", evidence: "setup prose", recordedAt: 5n }
		])
		yield* draft.insert(R.RetirementSetupResolution, [{ setup, evidence: "done", recordedAt: 6n }])
		yield* draft.insert(R.BookkeepingIssue, [
			{ id: bookkeeping, business, detail: "conflict", evidence: "issue prose", recordedAt: 7n }
		])
		yield* draft.insert(R.FinancialIssue, [
			{ id: financial, business, scope: "TaxAccount", evidence: "money prose", detail: "conflicting payment" }
		])
		yield* draft.insert(R.PaymentIssue, [{ issue: financial, business, account }])
		yield* draft.insert(R.FinancialResolution, [{ issue: financial, evidence: "reconciled", recordedAt: 8n }])
		yield* draft.insert(R.PolicyRelease, [
			{ id: release, sha256: "r", title: "t", evidence: "release prose", recordedAt: 9n }
		])
		yield* draft.insert(R.RateSchedule, [
			{
				id: schedule,
				denominator: 100n,
				domain: { start: 0n, end: (1n << 64n) - 1n },
				evidence: "shared prose"
			}
		])
		yield* draft.insert(R.TaxBand, [
			{ id: band, schedule, span: { start: 0n, end: (1n << 64n) - 1n }, numerator: 1n, role: "WithinBase" }
		])
		const snapshot = yield* history.snapshot({ consistency: { kind: "latest" } })
		const command = yield* Command.seal({
			scope: history.identity,
			id: { receiptEpoch: history.receiptEpoch, requestId: Result.getOrThrow(RequestId.from(yield* mintId)) },
			precondition: { kind: "exact-state", at: snapshot.stateStamp },
			changes: yield* draft.finish(),
			result: {}
		})
		const outcome = yield* history.submit(command, { attempts: 2, backoff: { baseMillis: 1, capMillis: 10 } })
		if (outcome.kind !== "decided") throw new Error("Seeding the old history did not decide")
		assert.equal(outcome.receipt.outcome.kind, "committed")
		const receipt = outcome.receipt
		return {
			history,
			binding,
			receipt,
			ids: {
				business,
				employee,
				plan,
				artifact,
				review,
				setup,
				financial,
				band,
				planAccount,
				report1099,
				report1096,
				account,
				payment
			}
		}
	})

/** Runs one released step against a binding: begin, populate, finish, inspect
 * (handing the inspected target to `check`), then activate. Returns the new binding. */
const migrate = <From extends AnySchema, To extends AnySchema>(
	step: Step<From, To>,
	binding: LocalBinding,
	check: (inspected: PublishedSnapshot<To>) => Effect.Effect<void, unknown>
) =>
	Effect.gen(function* () {
		const source = yield* LocalHistory.open(binding, step.from)
		const contract = {
			operation: Result.getOrThrow(OperationId.from(yield* mintId)),
			source: binding.identity,
			target: {
				...binding.identity,
				schemaId: (yield* Schema.compile(step.to)).schemaId,
				incarnationId: Result.getOrThrow(IncarnationId.from(yield* mintId))
			},
			commitment: "01".repeat(32)
		}
		const start = yield* Transition.begin(source, step.to, contract)
		assert.equal(start.kind, "populating")
		if (start.kind !== "populating") throw new Error("Expected a new population")
		yield* step.populate(start.source, start.population, mintId)
		const ready = yield* start.population.finish()
		assert.deepEqual(yield* Transition.resolve(source, step.to, contract), ready)
		yield* Effect.scoped(
			Effect.gen(function* () {
				const target = yield* LocalHistory.open(ready.binding, step.to)
				yield* check((yield* Transition.inspect(target, ready.installed)) as never)
			})
		)
		const activated = yield* Transition.activate(source, step.to, ready.installed)
		assert.deepEqual(yield* Transition.begin(source, step.to, contract), activated)
		return { activated, source }
	})

test("0000 → 0001 → 0002 carries every fact through statements, questions, Drive copies and typed columns", async () => {
	await Effect.runPromise(
		Effect.gen(function* () {
			const directory = yield* Effect.acquireRelease(
				io("create test directory", () => fs.mkdtemp(path.join(os.tmpdir(), "wagie-tools-cutover-"))),
				(directory) =>
					io("remove test directory", () => fs.rm(directory, { recursive: true, force: true })).pipe(
						Effect.orDie
					)
			)
			const seeded = yield* seedOld(path.join(directory, "old"))
			yield* seeded.history.close()
			const { ids } = seeded
			const R1 = s0001.schema.relations

			const first = yield* migrate(steps["0001-statements"], seeded.binding, (inspected) =>
				Effect.gen(function* () {
					const rowsOf = <K extends keyof typeof R1>(name: K) =>
						Effect.scoped(
							Effect.gen(function* () {
								const relation = R1[name] as typeof R1.Statement
								const template = query(s0001.schema).rule((r) => {
									const row = v(relation)
									return r.match(relation, row).find(row)
								})
								return (yield* (yield* inspected.execute(template, {})).collect()) as readonly Record<
									string,
									unknown
								>[]
							})
						)
					// Statements: identical prose is one row, content-addressed.
					const statements = yield* rowsOf("Statement")
					assert.equal(statements.filter((s) => s.text === "shared prose").length, 1)
					assert.equal(statements.find((s) => s.text === "shared prose")?.id, statementId("shared prose"))
					assert.equal((yield* rowsOf("TaxAccount"))[0]?.evidence, statementId("shared prose"))
					// Questions: four families, ids preserved, answers attached.
					const questions = yield* rowsOf("Question")
					assert.deepEqual(questions.map((q) => q.kind).sort(), [
						"Bookkeeping",
						"PlanSetup",
						"Review",
						"TaxAccount"
					])
					assert.ok(questions.some((q) => q.id === ids.review && q.kind === "Review"))
					assert.ok(questions.some((q) => q.id === ids.setup && q.kind === "PlanSetup"))
					assert.deepEqual(
						(yield* rowsOf("Answer")).map((a) => a.question).sort(),
						[ids.financial, ids.setup].sort()
					)
					assert.equal((yield* rowsOf("EmployeeQuestion"))[0]?.employee, ids.employee)
					assert.equal((yield* rowsOf("AccountQuestion")).length, 1)
					// Drive copy with de-duplicated priors; no plain location remains.
					const copies = yield* rowsOf("DriveCopy")
					assert.equal(copies.length, 1)
					assert.equal(copies[0]?.driveId, "abcdefghijklmnop")
					assert.equal(copies[0]?.evidence, statementId("archived to Drive"))
					assert.equal((yield* rowsOf("PriorLocation")).length, 2)
					assert.equal((yield* rowsOf("ArtifactLocation")).length, 0)
					// Renames and dropped timestamps.
					const bands = yield* rowsOf("TaxBand")
					assert.equal(bands[0]?.id, ids.band)
					assert.equal((bands[0]?.wages as { start: bigint } | undefined)?.start, 0n)
					assert.ok(!("recordedAt" in ((yield* rowsOf("Business"))[0] ?? {})))
					assert.equal((yield* rowsOf("RetirementReport")).length, 2)
					assert.equal((yield* rowsOf("BankReference")).length, 1)
				})
			)

			const second = yield* migrate(steps["0002-typed"], first.activated.binding, (inspected) =>
				Effect.gen(function* () {
					// Rosters.
					assert.equal((yield* relationRows(inspected, S.Employee))[0]?.filingStatus, "Single")
					assert.equal((yield* relationRows(inspected, S.BusinessAddress))[0]?.kind, "Business")
					// References: typed account, roster issuer, no restated bank references.
					const references = yield* select(inspected, S.PaymentReference, { account: ids.account })
					assert.deepEqual(references, [
						{ payment: ids.payment, account: ids.account, issuer: "EFTPS", value: "270556782874987" }
					])
					assert.ok(!("BankReference" in S.relations))
					assert.equal((yield* relationRows(inspected, S.MercuryTransaction)).length, 1)
					// Supplied reports as typed arms; ids preserved; digests re-derived.
					const reports = yield* select(inspected, S.RetirementReport, { plan: ids.plan })
					assert.deepEqual(
						reports.map((r) => [r.id, r.form]).sort(),
						[
							[ids.report1099, "F1099R"],
							[ids.report1096, "F1096"]
						].sort()
					)
					assert.deepEqual(yield* select(inspected, S.Reported1099R, { report: ids.report1099 }), [
						{
							report: ids.report1099,
							plan: ids.plan,
							account: ids.planAccount,
							distributionCode: "H",
							gross: 4296408n,
							taxable: 0n
						}
					])
					assert.deepEqual(yield* select(inspected, S.Reported1099RBasis, { report: ids.report1099 }), [
						{ report: ids.report1099, amount: 4296408n }
					])
					assert.deepEqual(yield* select(inspected, S.Reported1096, { report: ids.report1096 }), [
						{ report: ids.report1096, forms: 3n, gross: 9421153n }
					])
					// Every statement of 0001 survives, plus none lost.
					assert.equal((yield* select(inspected, S.Statement, { text: "shared prose" })).length, 1)
					// The register reads the migrated ledger: one open review question, no blockers.
					const register = yield* workRegister(inspected, ids.business, parseCalendarDate("2026-09-30"))
					assert.equal(register.readiness.filter((r) => r.kind === "Question").length, 1)
					// Re-derived filing digests: no "changed since submission" blocker.
					assert.ok(register.blockers.every((b) => b.rule !== "filing-correction"))
				})
			)

			// The activated 0002 ledger accepts new commands and the original receipts remain evidence.
			const target = yield* LocalHistory.open(second.activated.binding, S.ledger)
			const next = yield* ChangeSet.builder(S.ledger)
			yield* next.insert(S.Statement, [{ id: statementId("after") as Uuid, text: "after" }])
			assert.equal((yield* apply(target, yield* next.finish())).outcome.kind, "committed")
			const original = yield* first.source.resolve(seeded.receipt.command)
			assert.equal(original.kind, "found")
		}).pipe(Effect.scoped, Effect.provide(NativeRuntime.layer()))
	)
})

test("a filing digest depends on the facts, not on the order a caller assembled their columns", () => {
	const report = {
		id: statementId("r") as Uuid,
		plan: statementId("p") as Uuid,
		year: 2025n,
		artifact: statementId("a") as Uuid
	}
	const empty = {
		receipts: [],
		receiptDates: [],
		receiptAllocations: [],
		conversions: [],
		conversionReceipts: [],
		reportedConversions: [],
		suppliedTax: [],
		reported1099R: [],
		reported1099RBasis: [],
		reported1096: []
	}
	const declared = filingDigestOf({
		...empty,
		suppliedReports: [{ ...report, form: "F1096", evidence: statementId("e") as Uuid }]
	})
	const shuffled = filingDigestOf({
		...empty,
		suppliedReports: [{ evidence: statementId("e") as Uuid, form: "F1096", ...report }]
	})
	assert.equal(declared, shuffled)
	assert.notEqual(
		declared,
		filingDigestOf({
			...empty,
			suppliedReports: [{ ...report, form: "F1099R", evidence: statementId("e") as Uuid }]
		})
	)
})
