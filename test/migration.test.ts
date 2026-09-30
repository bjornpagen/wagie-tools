import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { ChangeSet, NativeRuntime, Schema, type Uuid } from "@bjornpagen/bumbledb"
import {
	Command,
	DatabaseId,
	IncarnationId,
	LocalHistory,
	OperationId,
	RequestId,
	Transition
} from "@bjornpagen/bumbledb-log"
import { Effect, Result } from "effect"
import * as old from "../migrations/0000-initial/schema.ts"
import { populateStatements } from "../migrations/0001-statements/cutover.ts"
import { inventory } from "../src/audit.ts"
import { statementId } from "../src/commands.ts"
import { io, readBytes } from "../src/core/files.ts"
import { parseCalendarDate } from "../src/core/time.ts"
import { mintId } from "../src/core/values.ts"
import { relationRows } from "../src/queries.ts"
import * as S from "../src/schema.ts"
import { workRegister } from "../src/work.ts"
import { apply } from "./native-history.ts"

const oldSnapshot = fileURLToPath(new URL("../migrations/0000-initial/schema.json", import.meta.url))

/** Creates a 0000 history with a small synthetic ledger holding every shape
 * the transformation must carry: prose evidence, a Drive-verified location
 * with prior locations, all four question families, a timestamped
 * approval without an id, and a TaxBand span. */
const seedOld = (directory: string) =>
	Effect.gen(function* () {
		const compiled = yield* Schema.compile(old.schema)
		const binding = {
			kind: "local" as const,
			directory,
			identity: {
				databaseId: Result.getOrThrow(DatabaseId.from(yield* mintId)),
				incarnationId: Result.getOrThrow(IncarnationId.from(yield* mintId)),
				schemaId: compiled.schemaId
			}
		}
		const history = yield* LocalHistory.create(binding, old.schema, {
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
			band = yield* mintId
		const R = old.schema.relations
		const draft = yield* ChangeSet.builder(old.schema)
		yield* draft.insert(R.Business, [
			{ id: business, name: "Synthetic", ein: "00-0000123", state: "TX", timeZone: "UTC", recordedAt: 1n }
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
			ids: { business, employee, plan, artifact, review, setup, financial, band }
		}
	})

test("0000 → 0001 carries every fact into statements, questions and Drive copies, then activates", async () => {
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
			const source = yield* LocalHistory.open(seeded.binding, old.schema)
			const contract = {
				operation: Result.getOrThrow(OperationId.from(yield* mintId)),
				source: seeded.binding.identity,
				target: {
					...seeded.binding.identity,
					schemaId: (yield* Schema.compile(S.ledger)).schemaId,
					incarnationId: Result.getOrThrow(IncarnationId.from(yield* mintId))
				},
				commitment: "01".repeat(32)
			}
			const start = yield* Transition.begin(source, S.ledger, contract)
			assert.equal(start.kind, "populating")
			if (start.kind !== "populating") throw new Error("Expected a new population")
			yield* populateStatements(start.source, start.population, mintId)
			const ready = yield* start.population.finish()
			assert.deepEqual(yield* Transition.resolve(source, S.ledger, contract), ready)
			yield* Effect.scoped(
				Effect.gen(function* () {
					const target = yield* LocalHistory.open(ready.binding, S.ledger)
					const inspected = yield* Transition.inspect(target, ready.installed)
					const facts = yield* inventory(inspected)
					const { ids } = seeded
					// Statements: identical prose is one row, content-addressed.
					const statements = yield* relationRows(inspected, S.Statement)
					assert.equal(statements.filter((s) => s.text === "shared prose").length, 1)
					assert.equal(statements.find((s) => s.text === "shared prose")?.id, statementId("shared prose"))
					const accounts = yield* relationRows(inspected, S.TaxAccount)
					assert.equal(accounts[0]?.evidence, statementId("shared prose"))
					// Questions: four families, ids preserved, answers attached.
					const questions = yield* relationRows(inspected, S.Question)
					assert.deepEqual(questions.map((q) => q.kind).sort(), [
						"Bookkeeping",
						"PlanSetup",
						"Review",
						"TaxAccount"
					])
					assert.ok(questions.some((q) => q.id === ids.review && q.kind === "Review"))
					assert.ok(questions.some((q) => q.id === ids.setup && q.kind === "PlanSetup"))
					const answers = yield* relationRows(inspected, S.Answer)
					assert.deepEqual(answers.map((a) => a.question).sort(), [ids.financial, ids.setup].sort())
					assert.equal((yield* relationRows(inspected, S.EmployeeQuestion))[0]?.employee, ids.employee)
					assert.equal((yield* relationRows(inspected, S.AccountQuestion)).length, 1)
					// Drive copy with de-duplicated priors; no plain location remains.
					const copies = yield* relationRows(inspected, S.DriveCopy)
					assert.equal(copies.length, 1)
					assert.equal(copies[0]?.driveId, "abcdefghijklmnop")
					assert.equal(copies[0]?.evidence, statementId("archived to Drive"))
					assert.equal((yield* relationRows(inspected, S.PriorLocation)).length, 2)
					assert.equal((yield* relationRows(inspected, S.ArtifactLocation)).length, 0)
					// Renames and dropped timestamps.
					const bands = yield* relationRows(inspected, S.TaxBand)
					assert.equal(bands[0]?.id, ids.band)
					assert.equal(bands[0]?.wages.start, 0n)
					const migratedBusiness = facts.Business?.[0]
					assert.ok(migratedBusiness !== undefined && !("recordedAt" in (migratedBusiness as object)))
					// The register reads the migrated ledger: one open review question, no blockers.
					const register = yield* workRegister(inspected, ids.business, parseCalendarDate("2026-09-30"))
					assert.equal(register.readiness.filter((r) => r.kind === "Question").length, 1)
				})
			)
			const activated = yield* Transition.activate(source, S.ledger, ready.installed)
			const target = yield* LocalHistory.open(activated.binding, S.ledger)
			const next = yield* ChangeSet.builder(S.ledger)
			yield* next.insert(S.Statement, [{ id: statementId("after") as Uuid, text: "after" }])
			assert.equal((yield* apply(target, yield* next.finish())).outcome.kind, "committed")
			assert.deepEqual(yield* Transition.begin(source, S.ledger, contract), activated)
			const original = yield* source.resolve(seeded.receipt.command)
			assert.equal(original.kind, "found")
		}).pipe(Effect.scoped, Effect.provide(NativeRuntime.layer()))
	)
})
