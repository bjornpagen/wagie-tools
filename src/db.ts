import { existsSync } from "node:fs"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import {
	type AnyRelation,
	ChangeSet,
	Db,
	decodeBoundaryField,
	encodeBoundaryField,
	type Fact,
	type ParamsRecord,
	type QueryTemplate,
	query,
	type Violation,
	v
} from "@bjornpagen/bumbledb"
import { Effect, Result } from "effect"
import { canonicalJson, Refusal } from "./core/values.ts"
import * as S from "./schema.ts"

export const repositoryRoot = fileURLToPath(new URL("../", import.meta.url))
export const ledgerPath = path.join(repositoryRoot, "private", "ledger")
/** Where `export` writes a ledger's backup unless told otherwise: beside it. */
export const backupOf = (ledger: string) =>
	path.join(path.dirname(ledger), "Wagie Tools - CURRENT.facts.json")

/** The stored relations; rosters are ground facts of the schema itself. */
export const stored = {
	Party: S.Party,
	Registration: S.Registration,
	Employment: S.Employment,
	Custody: S.Custody,
	History: S.History,
	TaxYear: S.TaxYear,
	TaxBand: S.TaxBand,
	PayPlan: S.PayPlan,
	Election: S.Election,
	Wage: S.Wage,
	Withholding: S.Withholding,
	Recovery: S.Recovery,
	Transfer: S.Transfer,
	NetPay: S.NetPay,
	RothDeferral: S.RothDeferral,
	AfterTax: S.AfterTax,
	Distribution: S.Distribution,
	TaxDebit: S.TaxDebit,
	TaxPayment: S.TaxPayment,
	Filing: S.Filing,
	Electronic: S.Electronic,
	CertifiedMail: S.CertifiedMail,
	Furnished: S.Furnished,
	FiledFigures: S.FiledFigures,
	Correction: S.Correction,
	CorrectedFigures: S.CorrectedFigures,
	Rollover: S.Rollover,
	Carried: S.Carried
} as const
export type Stored = typeof stored
export type Name = keyof Stored
export type Facts = { readonly [N in Name]: readonly Fact<Stored[N]>[] }
type Ledger = Db<typeof S.ledger>

const everyRow = Object.fromEntries(
	Object.entries(stored).map(([name, relation]) => [
		name,
		query(S.ledger).rule((r) => {
			const row = v(relation as typeof S.Wage)
			return r.match(relation as typeof S.Wage, row).find(row)
		})
	])
) as unknown as { readonly [N in Name]: QueryTemplate<typeof S.ledger, ParamsRecord, unknown> }

/** One consistent read of the whole ledger (a few hundred facts) and the
 * witness of the state it saw. */
export const readFacts = (db: Ledger) =>
	Effect.scoped(
		Effect.gen(function* () {
			const snapshot = yield* db.snapshot()
			const facts: Record<string, readonly unknown[]> = {}
			for (const name of Object.keys(stored) as Name[])
				facts[name] = yield* (yield* snapshot.execute(everyRow[name] as never, {})).collect()
			return { facts: facts as Facts, witness: snapshot.witness }
		})
	)

/** A write is a list of edits, computed purely from the facts it read. */
export type Edit = { readonly op: "insert" | "delete"; readonly relation: Name; readonly fact: object }
export const insert = <N extends Name>(relation: N, ...facts: Fact<Stored[N]>[]): Edit[] =>
	facts.map((fact) => ({ op: "insert", relation, fact }))
export const remove = <N extends Name>(relation: N, ...facts: Fact<Stored[N]>[]): Edit[] =>
	facts.map((fact) => ({ op: "delete", relation, fact }))
export type Plan<A> = { readonly edits: readonly Edit[]; readonly result: A }

/** The edits as one change set, alive for the enclosing scope. */
const changeSet = (edits: readonly Edit[]) =>
	Effect.gen(function* () {
		const draft = yield* ChangeSet.builder(S.ledger)
		for (const edit of edits) {
			const relation = stored[edit.relation] as typeof S.Wage
			const facts = [edit.fact as Fact<typeof S.Wage>]
			yield* edit.op === "insert" ? draft.insert(relation, facts) : draft.delete(relation, facts)
		}
		return yield* draft.finish()
	})

const render = (violations: readonly Violation[]) =>
	violations.map((violation) => `${violation.kind}: ${violation.canonical}`).join("\n")

/** Plan on one snapshot and apply against exactly that state (cookbook §10).
 * If another write landed in between, plan once more on the new state. */
export const write = <A>(db: Ledger, plan: (facts: Facts) => Plan<A>) =>
	Effect.gen(function* () {
		for (let attempt = 1; ; attempt++) {
			const { facts, witness } = yield* readFacts(db)
			const planned = plan(facts)
			const outcome = yield* Effect.scoped(
				Effect.flatMap(changeSet(planned.edits), (changes) =>
					db.apply(changes, { expected: { kind: "exact", at: witness } })
				)
			)
			if (outcome.kind === "moved" && attempt < 2) continue
			if (outcome.kind === "moved")
				return yield* Effect.fail(
					new Refusal({ code: "Moved", message: "The ledger kept changing; try again" })
				)
			if (outcome.kind === "invariant-rejected")
				return yield* Effect.fail(new Refusal({ code: "LawRefused", message: render(outcome.violations) }))
			return { outcome: outcome.kind === "accepted" ? "committed" : "no-change", ...planned.result }
		}
	})

/** The same plan judged without committing (cookbook §3). */
export const judge = <A>(db: Ledger, plan: (facts: Facts) => Plan<A>) =>
	Effect.gen(function* () {
		const { facts, witness } = yield* readFacts(db)
		const planned = plan(facts)
		const outcome = yield* Effect.scoped(
			Effect.flatMap(changeSet(planned.edits), (changes) =>
				db.judge(changes, { expected: { kind: "exact", at: witness } })
			)
		)
		return {
			...planned.result,
			laws:
				outcome.kind === "invariant-rejected"
					? render(outcome.violations)
					: outcome.kind === "moved"
						? "moved"
						: "admitted"
		}
	})

export const open = (directory = ledgerPath) => Db.open(directory, S.ledger)
export const create = (directory = ledgerPath) => Db.create(directory, S.ledger)

/** Every fact as canonical boundary JSON: the backup, and the only migration
 * path (export, transform, import). */
export const exportFacts = (facts: Facts) =>
	canonicalJson(
		Object.fromEntries(
			(Object.keys(stored) as Name[]).map((name) => {
				const fields = (stored[name] as AnyRelation).fields as Record<
					string,
					Parameters<typeof encodeBoundaryField>[0]
				>
				const rows = facts[name].map((fact) =>
					Object.fromEntries(
						Object.entries(fields).map(([field, descriptor]) => [
							field,
							Result.getOrThrow(
								encodeBoundaryField(descriptor, (fact as Record<string, unknown>)[field] as never)
							)
						])
					)
				)
				return [
					name,
					rows
						.map((row) => canonicalJson(row))
						.sort()
						.map((row) => JSON.parse(row))
				]
			})
		),
		1
	)

const invalid = (message: string): never => {
	throw new Refusal({ code: "InvalidExport", message })
}
const isObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value)

/** An export's facts as inserts. Anything but what `export` writes refuses:
 * one object of relations, each a list of rows with exactly its fields, no
 * row twice, and at least one fact. */
export const importEdits = (text: string): Edit[] => {
	let data: unknown
	try {
		data = JSON.parse(text)
	} catch (error) {
		return invalid(`Not JSON: ${error instanceof Error ? error.message : String(error)}`)
	}
	if (!isObject(data)) return invalid("An export is one JSON object of relations")
	const unknown = Object.keys(data).filter((name) => !Object.hasOwn(stored, name))
	if (unknown.length) throw new Refusal({ code: "UnknownRelation", message: unknown.join(", ") })
	const edits = (Object.keys(stored) as Name[]).flatMap((name) => {
		const fields = (stored[name] as AnyRelation).fields as Record<
			string,
			Parameters<typeof decodeBoundaryField>[0]
		>
		const rows = data[name] ?? []
		if (!Array.isArray(rows)) return invalid(`${name} is not a list of rows`)
		const seen = new Set<string>()
		return rows.map((row: unknown) => {
			if (!isObject(row)) return invalid(`${name}: a row is not an object: ${JSON.stringify(row)}`)
			const extra = Object.keys(row).filter((field) => !Object.hasOwn(fields, field))
			if (extra.length) invalid(`${name}: unknown fields ${extra.join(", ")}`)
			const key = canonicalJson(row)
			if (seen.has(key)) invalid(`${name}: the same row twice: ${key}`)
			seen.add(key)
			return {
				op: "insert" as const,
				relation: name,
				fact: Object.fromEntries(
					Object.entries(fields).map(([field, descriptor]) => {
						const decoded = decodeBoundaryField(descriptor, row[field])
						if (Result.isFailure(decoded)) invalid(`${name}.${field}: ${JSON.stringify(row[field])}`)
						return [field, Result.getOrThrow(decoded)]
					})
				)
			}
		})
	})
	if (edits.length === 0) return invalid("The export has no facts")
	return edits
}

export const readText = (file: string) =>
	Effect.tryPromise({
		try: () => fs.readFile(file, "utf8"),
		catch: (cause) => new Refusal({ code: "FileAccess", message: String(cause) })
	})
/** Replace a file whole: write a sibling, then rename it over the original. */
export const writeText = (file: string, text: string) =>
	Effect.tryPromise({
		try: async () => {
			await fs.mkdir(path.dirname(file), { recursive: true })
			await fs.writeFile(`${file}.partial`, text)
			await fs.rename(`${file}.partial`, file)
		},
		catch: (cause) => new Refusal({ code: "FileAccess", message: String(cause) })
	})

/** setup and import start a ledger. Neither touches one that exists, and a
 * ledger whose first write is refused is removed again. */
export const build = <A>(directory: string, plan: Plan<A>) =>
	Effect.suspend(() => {
		if (existsSync(directory))
			return Effect.fail(new Refusal({ code: "LedgerExists", message: `${directory} already exists` }))
		let created = false
		return Effect.scoped(
			Effect.gen(function* () {
				const db = yield* create(directory)
				created = true
				return yield* write(db, () => plan)
			})
		).pipe(
			Effect.onError(() =>
				created ? Effect.promise(() => fs.rm(directory, { recursive: true, force: true })) : Effect.void
			)
		)
	})
