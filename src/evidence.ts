import { createHash } from "node:crypto"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"
import type { Uuid } from "@bjornpagen/bumbledb"
import { Effect, Schema } from "effect"
import { businessCommand } from "./commands.ts"
import { readBytes } from "./core/files.ts"
import { entityId, mintId, Nonblank, Refusal } from "./core/values.ts"
import { relationRows } from "./queries.ts"
import { parseStrict, type Snapshot } from "./runtime.ts"
import { commandFields, Day, Id, inputFields } from "./schema/input.ts"
import * as S from "./schema.ts"

export const ArtifactRecordInput = Schema.Struct({
	...commandFields,
	file: Nonblank,
	...inputFields(S.Artifact, ["mediaType"]),
	evidence: Nonblank
})
export const ArtifactLocateInput = Schema.Struct({
	...commandFields,
	...inputFields(S.ArtifactLocation, ["artifact", "locator", "evidence"])
})
export const ArtifactVerifyInput = Schema.Struct({
	...commandFields,
	...inputFields(S.ArtifactLocation, ["artifact", "evidence"]),
	file: Nonblank
})

const content = (file: string) =>
	readBytes(file).pipe(
		Effect.map((bytes) => ({
			sha256: createHash("sha256").update(bytes).digest("hex"),
			length: BigInt(bytes.byteLength)
		}))
	)

export const verifyDocument = (snapshot: Snapshot, artifact: Uuid, file: string) =>
	Effect.gen(function* () {
		const expected = (yield* relationRows(snapshot, S.Artifact)).find((row) => row.id === artifact)
		if (!expected)
			return yield* Effect.fail(new Refusal({ code: "ArtifactMissing", message: `No artifact ${artifact}` }))
		const measured = yield* content(file)
		if (measured.sha256 !== expected.sha256)
			return yield* Effect.fail(
				new Refusal({
					code: "ArtifactChanged",
					message: `The supplied bytes do not match artifact ${artifact}`
				})
			)
		return measured
	})

/** Register observed bytes; hashes are never asserted from filenames/locators. */
export const recordArtifact = (payload: unknown) =>
	Effect.gen(function* () {
		const input = parseStrict(ArtifactRecordInput, payload)
		return yield* businessCommand({
			request: input.request,
			business: input.business,
			action: "artifact record",
			input: payload,
			plan: ({ snapshot, draft, recordedAt }) =>
				Effect.gen(function* () {
					const measured = yield* content(input.file)
					const existing = (yield* relationRows(snapshot, S.Artifact)).find(
						(row) => row.sha256 === measured.sha256
					)
					if (existing && existing.mediaType !== input.mediaType)
						return yield* Effect.fail(
							new Refusal({
								code: "ArtifactMetadataConflict",
								message: "These bytes already have a different recorded media type"
							})
						)
					const artifact = existing?.id ?? (yield* mintId)
					if (!existing)
						yield* draft.insert(S.Artifact, [
							{ id: artifact, sha256: measured.sha256, mediaType: input.mediaType }
						])
					const verified = (yield* relationRows(snapshot, S.VerifiedArtifact)).find(
						(row) => row.artifact === artifact
					)
					if (verified) yield* draft.delete(S.VerifiedArtifact, [verified])
					yield* draft.insert(S.VerifiedArtifact, [
						{ artifact, length: measured.length, verifiedAt: recordedAt }
					])
					const locator = pathToFileURL(resolve(input.file)).href
					const knownLocation = (yield* relationRows(snapshot, S.ArtifactLocation)).find(
						(row) => row.artifact === artifact && row.locator === locator
					)
					if (!knownLocation)
						yield* draft.insert(S.ArtifactLocation, [{ artifact, locator, evidence: input.evidence }])
					return { artifact, sha256: measured.sha256, length: measured.length }
				})
		})
	})

export const locateArtifact = (payload: unknown) =>
	Effect.gen(function* () {
		const input = parseStrict(ArtifactLocateInput, payload)
		const artifact = input.artifact
		return yield* businessCommand({
			request: input.request,
			business: input.business,
			action: "artifact locate",
			input: payload,
			plan: ({ snapshot, draft }) =>
				Effect.gen(function* () {
					const existing = (yield* relationRows(snapshot, S.ArtifactLocation)).find(
						(row) => row.artifact === artifact && row.locator === input.locator
					)
					if (!existing)
						yield* draft.insert(S.ArtifactLocation, [
							{ artifact, locator: input.locator, evidence: input.evidence }
						])
					return { artifact, locator: input.locator }
				})
		})
	})

/** Verification changes only observed verification metadata. Changed bytes
 * refuse against this identity; record them separately as another artifact.
 */
export const verifyArtifact = (payload: unknown) =>
	Effect.gen(function* () {
		const input = parseStrict(ArtifactVerifyInput, payload)
		const artifact = input.artifact
		return yield* businessCommand({
			request: input.request,
			business: input.business,
			action: "artifact verify",
			input: payload,
			plan: ({ snapshot, draft, recordedAt }) =>
				Effect.gen(function* () {
					const expected = (yield* relationRows(snapshot, S.Artifact)).find((row) => row.id === artifact)
					if (!expected)
						return yield* Effect.fail(
							new Refusal({ code: "ArtifactMissing", message: `No artifact ${artifact}` })
						)
					const measured = yield* content(input.file)
					if (measured.sha256 !== expected.sha256)
						return yield* Effect.fail(
							new Refusal({
								code: "ArtifactChanged",
								message: "The retrieved bytes do not match this artifact's SHA-256"
							})
						)
					const previous = (yield* relationRows(snapshot, S.VerifiedArtifact)).find(
						(row) => row.artifact === artifact
					)
					if (previous) yield* draft.delete(S.VerifiedArtifact, [previous])
					yield* draft.insert(S.VerifiedArtifact, [
						{ artifact, length: measured.length, verifiedAt: recordedAt }
					])
					const locator = pathToFileURL(resolve(input.file)).href
					if (
						!(yield* relationRows(snapshot, S.ArtifactLocation)).some(
							(row) => row.artifact === artifact && row.locator === locator
						)
					)
						yield* draft.insert(S.ArtifactLocation, [{ artifact, locator, evidence: input.evidence }])
					return { artifact, sha256: measured.sha256, length: measured.length }
				})
		})
	})

export const MailingRecordInput = Schema.Struct({
	...commandFields,
	...inputFields(S.CertifiedMailing, ["carrier", "number", "mailedOn", "receipt", "evidence"], {
		carrier: Schema.Literal("USPS"),
		mailedOn: Day
	}),
	artifacts: Schema.Array(Id)
})

/** One physical certified packet can be referenced by many form submissions. */
export const recordMailing = (payload: unknown) =>
	Effect.gen(function* () {
		const input = parseStrict(MailingRecordInput, payload)
		const business = input.business,
			mailedOn = input.mailedOn
		const number = input.number.replace(/\s+/g, "")
		return yield* businessCommand({
			request: input.request,
			business,
			action: "mailing record",
			input: payload,
			plan: ({ snapshot, draft, recordingDay }) =>
				Effect.gen(function* () {
					if (mailedOn > recordingDay)
						return yield* Effect.fail(
							new Refusal({
								code: "FutureMailing",
								message: "Record the actual date after the packet was mailed"
							})
						)
					const existing = (yield* relationRows(snapshot, S.CertifiedMailing)).find(
						(row) => row.carrier === input.carrier && row.number === number
					)
					if (existing && (existing.business !== business || existing.mailedOn !== mailedOn))
						return yield* Effect.fail(
							new Refusal({
								code: "MailingConflict",
								message: "This certified number is already recorded for another business or mailing date"
							})
						)
					const mailing = existing?.id ?? (yield* mintId)
					if (!existing)
						yield* draft.insert(S.CertifiedMailing, [
							{
								id: mailing,
								business,
								carrier: input.carrier,
								number,
								mailedOn,
								receipt: input.receipt,
								evidence: input.evidence
							}
						])
					const artifacts = new Set([input.receipt, ...input.artifacts])
					yield* draft.insert(
						S.MailingEvidence,
						[...artifacts].map((id) => ({ mailing, artifact: entityId(id) }))
					)
					return { mailing, certifiedNumber: number, observedPreviously: Boolean(existing) }
				})
		})
	})
