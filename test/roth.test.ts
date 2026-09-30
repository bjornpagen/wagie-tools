import assert from "node:assert/strict"
import * as path from "node:path"
import { test } from "node:test"
import { ChangeSet } from "@bjornpagen/bumbledb"
import { Effect } from "effect"
import { encodeOutput, formatDollars, parseDollars } from "../src/core/boundary.ts"
import { parseCalendarDate, periodSpan } from "../src/core/time.ts"
import { mintId, Refusal } from "../src/core/values.ts"
import { attachBankArtifact } from "../src/documents.ts"
import { recordArtifact } from "../src/evidence.ts"
import { calculatePayroll, inspectCalculation, postPayroll } from "../src/payroll.ts"
import { relationRows } from "../src/queries.ts"
import { Ledger, latest } from "../src/runtime.ts"
import * as S from "../src/schema.ts"
import { workRegister } from "../src/work.ts"
import { assertRefusal as refusal, resultId } from "./assertions.ts"
import { apply, atTime, say, withHistory } from "./native-history.ts"
import { evidence, readyPayroll } from "./payroll-fixture.ts"

test("dollars at the boundary are exact, two-decimal, and refuse anything else", () => {
	assert.equal(parseDollars("8000.00"), 800000n)
	assert.equal(parseDollars("0.01"), 1n)
	assert.equal(parseDollars("-12.34"), -1234n)
	assert.equal(formatDollars(866271n), "8662.71")
	assert.equal(formatDollars(5n), "0.05")
	assert.equal(formatDollars(-100n), "-1.00")
	for (const bad of ["8000", "8000.0", "8,000.00", "$8000.00", "8000.000", ".50", "-0.00", "1e3"])
		assert.throws(() => parseDollars(bad), Refusal, bad)
	const encoded = encodeOutput(
		{
			amount: 123456n,
			paidOn: { start: 20712n, end: 20713n },
			period: { start: 20454n, end: 20819n },
			earning: { start: 0n, end: (1n << 64n) - 1n },
			year: 2026n,
			evidence: "stmt-1",
			nested: [{ dueOn: 20741n }]
		},
		new Map([["stmt-1", "the prose"]])
	)
	assert.deepEqual(encoded, {
		amount: "1234.56",
		paidOn: "2026-09-16",
		period: { start: "2026-01-01", endExclusive: "2027-01-01" },
		earning: { start: "0.00", end: "Infinity" },
		year: 2026,
		evidence: "the prose",
		nested: [{ dueOn: "2026-10-15" }]
	})
	assert.throws(() => encodeOutput({ mystery: 1n }, new Map()), Refusal)
})

/** A plan, annual review, signed election and allowance for one employee. */
const electRoth = (
	history: Parameters<typeof readyPayroll>[0],
	fixture: { business: string; employee: string; release: string; calendar: string }
) =>
	Effect.gen(function* () {
		const { business, employee, release, calendar } = fixture as {
			business: import("@bjornpagen/bumbledb").Uuid
			employee: import("@bjornpagen/bumbledb").Uuid
			release: import("@bjornpagen/bumbledb").Uuid
			calendar: import("@bjornpagen/bumbledb").Uuid
		}
		const rules = yield* ChangeSet.builder(S.ledger)
		const policy = yield* mintId,
			allowance = yield* mintId,
			election = yield* mintId,
			plan = yield* mintId,
			document = yield* mintId,
			artifact = yield* mintId,
			annual = yield* mintId
		yield* rules.insert(S.DeferralPolicy, [
			{ id: policy, release, year: 2026n, limit: 2400000n, evidence: say(evidence) }
		])
		yield* rules.insert(S.EmployeeAllowance, [
			{
				id: allowance,
				employee,
				year: 2026n,
				policy,
				maximum: 2400000n,
				limit: 2400000n,
				evidence: say(evidence)
			}
		])
		yield* rules.insert(S.Election, [
			{
				id: election,
				employee,
				year: 2026n,
				calendar,
				allowance,
				maximum: 2400000n,
				signedOn: parseCalendarDate("2026-09-01"),
				effective: periodSpan(2026, "Year"),
				limit: 2400000n,
				evidence: say(evidence)
			}
		])
		yield* rules.insert(S.Owner, [{ business, employee, evidence: say(evidence) }])
		yield* rules.insert(S.RetirementPlan, [
			{ id: plan, business, employee, name: "Synthetic Plan", ein: "00-0000021", evidence: say(evidence) }
		])
		yield* rules.insert(S.RetirementAnnual, [
			{
				id: annual,
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
				evidence: say(evidence)
			}
		])
		yield* rules.insert(S.Artifact, [
			{ id: artifact, sha256: "synthetic-election-2", mediaType: "application/pdf" }
		])
		yield* rules.insert(S.VerifiedArtifact, [{ artifact, length: 1n }])
		yield* rules.insert(S.ElectionDocument, [
			{
				id: document,
				employee,
				year: 2026n,
				signedOn: parseCalendarDate("2026-09-01"),
				artifact,
				evidence: say(evidence)
			}
		])
		yield* rules.insert(S.ElectionDocumentAmount, [
			{ document, kind: "Roth", amount: 2400000n },
			{ document, kind: "Traditional", amount: 0n },
			{ document, kind: "OptionalAfterTax", amount: 0n },
			{ document, kind: "EmployerProfitSharing", amount: 0n }
		])
		yield* rules.insert(S.ElectionSource, [
			{
				election,
				document,
				annual,
				employee,
				year: 2026n,
				signedOn: parseCalendarDate("2026-09-01"),
				kind: "Roth",
				limit: 2400000n
			}
		])
		assert.equal((yield* apply(history, yield* rules.finish())).outcome.kind, "committed")
		return { plan }
	})

test("RothOnly solves the gross for exactly zero cash, and a sent Mercury receipt clears the payroll gate while Carry stays a reminder", async () => {
	await withHistory((history, binding, directory) =>
		atTime(
			Date.parse("2026-09-16T17:00:00Z"),
			Effect.gen(function* () {
				const fixture = yield* readyPayroll(history, 31)
				const { business, employee } = fixture
				yield* electRoth(history, fixture)
				const day = parseCalendarDate("2026-09-16")
				const calculated = yield* calculatePayroll({
					request: yield* mintId,
					business,
					employee,
					purpose: {
						kind: "RothOnly",
						paidOn: "2026-09-16",
						roth: "8000.00",
						work: { start: "2026-09-09", endExclusive: "2026-09-16" }
					},
					fit: { amount: "0.01", evidence },
					evidence
				})
				const calculation = resultId(calculated, "calculation")
				const figures = yield* inspectCalculation(yield* latest, business, calculation)
				assert.ok(figures.paycheck)
				assert.equal(figures.paycheck.cash, 0n, "the solved gross leaves exactly zero cash")
				assert.equal(figures.paycheck.roth, 800000n)
				// 6.2% + 1.45% employee FICA on the fixture bands plus one cent of FIT.
				const gross = figures.input.gross
				assert.equal(gross, 866271n)
				assert.equal(figures.amounts.find((row) => row.component === "EmployeeSS")?.amount, 53709n)
				assert.equal(figures.amounts.find((row) => row.component === "EmployeeMedicare")?.amount, 12561n)

				// Posting a zero-cash Roth wire takes the wire as the settlement.
				const reference = yield* mintId
				yield* postPayroll({
					request: yield* mintId,
					business,
					calculation,
					evidence: "Owner approved the $8,000.00 Roth wire; Mercury sent it today",
					settlement: { kind: "Bank", reference, paidOn: "2026-09-16", amount: "8000.00" }
				})
				let register = yield* workRegister(yield* latest, business, day)
				const remittance = register.blockers.find((item) => item.rule === "roth-remittance")
				assert.ok(remittance, "funded but unreceipted Roth still blocks payroll")
				assert.equal(remittance.next.op, "artifact.attach-bank")
				assert.equal(remittance.amount, 0n)
				const reminder = register.work.find((item) => item.rule === "roth-plan-receipt")
				assert.equal(reminder?.gates, "None")
				assert.equal(reminder?.status, "Open")

				// Posted facts cite the posting evidence, not the calculation's draft text.
				const posted = say("Owner approved the $8,000.00 Roth wire; Mercury sent it today")
				const deductions = (yield* relationRows(yield* latest, S.Deduction)).filter(
					(row) => row.kind === "Roth"
				)
				assert.equal(deductions[0]?.evidence, posted)

				// Attach the Mercury receipt: option B.
				const file = path.join(directory, "wire.pdf")
				yield* Effect.promise(() =>
					import("node:fs/promises").then((fs) => fs.writeFile(file, "wire receipt"))
				)
				const recorded = yield* recordArtifact({
					request: yield* mintId,
					business,
					file,
					mediaType: "application/pdf",
					evidence: "Mercury receipt, status Sent"
				})
				const movement = (yield* relationRows(yield* latest, S.MercuryTransaction)).find(
					(row) => row.reference === reference
				)
				assert.ok(movement)
				yield* attachBankArtifact({
					request: yield* mintId,
					business,
					artifact: resultId(recorded, "artifact"),
					movement: movement.movement,
					evidence: "Receipt names this wire's transaction ID"
				})
				register = yield* workRegister(yield* latest, business, day)
				assert.equal(register.blockers.length, 0, "a sent receipt clears the gate")
				assert.equal(register.work.find((item) => item.rule === "roth-remittance")?.status, "Complete")
				assert.equal(register.work.find((item) => item.rule === "roth-plan-receipt")?.status, "Open")

				// A wrong Roth still refuses cleanly.
				refusal(
					yield* Effect.result(
						calculatePayroll({
							request: yield* mintId,
							business,
							employee,
							purpose: {
								kind: "RothOnly",
								paidOn: "2026-09-16",
								roth: "0.00",
								work: { start: "2026-09-16", endExclusive: "2026-09-17" }
							},
							fit: { amount: "0.00", evidence },
							evidence
						})
					),
					"RothRequired"
				)
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
