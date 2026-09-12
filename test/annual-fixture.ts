import assert from "node:assert/strict"
import { ChangeSet, type Uuid } from "@bjornpagen/bumbledb"
import { Effect } from "effect"
import { periodSpan } from "../src/core/time.ts"
import { MAX_U64, mintId } from "../src/core/values.ts"
import { relationRows } from "../src/queries.ts"
import type { LedgerHistory } from "../src/runtime.ts"
import { annualRequirements } from "../src/schema/vocabulary.ts"
import * as S from "../src/schema.ts"
import { apply } from "./native-history.ts"

export const seedAnnualPolicies = (history: LedgerHistory, business: Uuid, release: Uuid, approve = true) =>
	Effect.gen(function* () {
		const snapshot = yield* history.snapshot({ consistency: { kind: "latest" } })
		const calendars = yield* relationRows(snapshot, S.CalendarPeriod)
		const versions = yield* relationRows(snapshot, S.RateVersion)
		const draft = yield* ChangeSet.builder(S.ledger)
		const artifact = yield* mintId,
			evidence = "Synthetic annual policy test evidence"
		yield* draft.insert(S.Artifact, [
			{ id: artifact, sha256: `synthetic-${artifact}`, mediaType: "text/plain" }
		])
		yield* draft.insert(S.VerifiedArtifact, [{ artifact, length: 1n, verifiedAt: 0n }])
		const policies = []
		for (const authority of S.Authority.handles) {
			const calendar = calendars.find(
				(row) =>
					row.release === release && row.authority === authority && row.kind === "Year" && row.year === 2026n
			)
			assert.ok(calendar)
			const annual = yield* mintId,
				required = annualRequirements[authority]
			yield* draft.insert(S.AnnualPolicy, [
				{
					id: annual,
					business,
					authority,
					year: 2026n,
					calendar: calendar.id,
					valid: periodSpan(2026, "Year"),
					evidence,
					recordedAt: 0n
				}
			])
			yield* draft.insert(S.AnnualSource, [{ annual, artifact, evidence }])
			for (const kind of required.rates) {
				const component = kind === "FUTAFullCredit" ? "FUTA" : kind === "SUTAEntry" ? "SUTA" : kind
				let schedule = versions.find(
					(row) => row.release === release && row.business === business && row.component === component
				)?.schedule
				if (!schedule) {
					schedule = yield* mintId
					yield* draft.insert(S.RateSchedule, [
						{ id: schedule, denominator: 10000n, domain: { start: 0n, end: MAX_U64 }, evidence }
					])
					yield* draft.insert(S.TaxBand, [
						{ id: yield* mintId, schedule, span: { start: 0n, end: MAX_U64 }, numerator: 0n, role: "Excess" }
					])
				}
				yield* draft.insert(S.PublishedRate, [{ annual, kind, schedule, artifact, evidence }])
			}
			const limits = {
				RegularDeferral: 2400000n,
				AnnualAdditions: 7100000n,
				MonthlyLookbackMaximum: 5000000n,
				NextDayDepositMinimum: 10000000n,
				FUTAInterimMinimum: 50001n,
				StateWageBase: 900000n
			}
			for (const kind of required.limits)
				yield* draft.insert(S.PolicyLimit, [{ annual, kind, cents: limits[kind], artifact, evidence }])
			for (const kind of required.evidence)
				yield* draft.insert(S.AnnualEvidence, [{ annual, kind, artifact, evidence, recordedAt: 0n }])
			if (authority === "FederalDC")
				yield* draft.insert(S.LookbackPeriod, [
					{ annual, span: periodSpan(2025, "Year"), artifact, evidence }
				])
			const approval = {
				annual,
				release,
				business,
				authority,
				year: 2026n,
				valid: periodSpan(2026, "Year"),
				evidence,
				recordedAt: 0n
			}
			if (approve) yield* draft.insert(S.AnnualApproval, [approval])
			policies.push(approval)
		}
		assert.equal((yield* apply(history, yield* draft.finish())).outcome.kind, "committed")
		return { policies, artifact }
	})
