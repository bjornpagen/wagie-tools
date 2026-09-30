import type { Uuid } from "@bjornpagen/bumbledb"
import { Effect, Schema } from "effect"
import { businessCommand, type Note } from "./commands.ts"
import { mintId, Nonblank, Refusal } from "./core/values.ts"
import { relationRows, select } from "./queries.ts"
import { type Draft, parseStrict, type Snapshot } from "./runtime.ts"
import { commandFields, Id, inputFields } from "./schema/input.ts"
import * as S from "./schema.ts"

export type QuestionKind = (typeof S.QuestionKind.handles)[number]

/** Which work an open question holds back is a property of its kind alone. */
export const questionGate = {
	Review: "None",
	PlanSetup: "RetirementFunding",
	Bookkeeping: "RetirementFunding",
	TaxAccount: "Payroll"
} as const satisfies Record<QuestionKind, "Payroll" | "RetirementFunding" | "None">

/** One arm per kind; the arm carries exactly that kind's subject. */
export const QuestionSubject = Schema.Union([
	Schema.Struct({
		kind: Schema.Literal("Review"),
		...inputFields(S.EmployeeQuestion, ["employee", "year", "topic"])
	}),
	Schema.Struct({ kind: Schema.Literal("PlanSetup"), ...inputFields(S.PlanQuestion, ["plan"]) }),
	Schema.Struct({ kind: Schema.Literal("Bookkeeping") }),
	Schema.Struct({ kind: Schema.Literal("TaxAccount"), ...inputFields(S.AccountQuestion, ["account"]) })
])
export type QuestionSubject = typeof QuestionSubject.Type

/** Writes the header and its one sidecar together; the schema's exhaustive
 * alternatives refuse a header without its arm or an arm under the wrong kind. */
export const askQuestion = (
	draft: Draft,
	note: Note,
	business: Uuid,
	subject: QuestionSubject,
	detail: string,
	evidence: string
) =>
	Effect.gen(function* () {
		const question = yield* mintId
		yield* draft.insert(S.Question, [{ id: question, business, kind: subject.kind, detail }])
		switch (subject.kind) {
			case "Review":
				yield* draft.insert(S.EmployeeQuestion, [
					{ question, business, employee: subject.employee, year: subject.year, topic: subject.topic }
				])
				break
			case "PlanSetup":
				yield* draft.insert(S.PlanQuestion, [
					{ question, business, plan: subject.plan, evidence: yield* note(evidence) }
				])
				break
			case "Bookkeeping":
				yield* draft.insert(S.BookkeepingQuestion, [{ question, evidence: yield* note(evidence) }])
				break
			case "TaxAccount":
				yield* draft.insert(S.AccountQuestion, [
					{ question, business, account: subject.account, evidence: yield* note(evidence) }
				])
				break
		}
		return question
	})

/** Every question of a business, decoded once into its arm. */
export const questions = (snapshot: Snapshot, business: Uuid) =>
	Effect.gen(function* () {
		const headers = yield* select(snapshot, S.Question, { business })
		const employees = new Map((yield* relationRows(snapshot, S.EmployeeQuestion)).map((r) => [r.question, r]))
		const plans = new Map((yield* relationRows(snapshot, S.PlanQuestion)).map((r) => [r.question, r]))
		const books = new Map((yield* relationRows(snapshot, S.BookkeepingQuestion)).map((r) => [r.question, r]))
		const accounts = new Map((yield* relationRows(snapshot, S.AccountQuestion)).map((r) => [r.question, r]))
		const answers = new Map((yield* relationRows(snapshot, S.Answer)).map((r) => [r.question, r]))
		type Decoded = {
			id: (typeof headers)[number]["id"]
			detail: string
			gates: (typeof questionGate)[QuestionKind]
			answer: { id: (typeof headers)[number]["id"]; evidence: (typeof headers)[number]["id"] } | undefined
			kind: QuestionKind
			employee?: (typeof headers)[number]["id"] | undefined
			year?: bigint | undefined
			topic?: string | undefined
			plan?: (typeof headers)[number]["id"] | undefined
			account?: (typeof headers)[number]["id"] | undefined
			evidence?: (typeof headers)[number]["id"] | undefined
		}
		return headers.map((header): Decoded => {
			const answer = answers.get(header.id)
			const base = {
				id: header.id,
				detail: header.detail,
				gates: questionGate[header.kind],
				answer: answer ? { id: answer.id, evidence: answer.evidence } : undefined
			}
			const arms = {
				Review: () => {
					const arm = employees.get(header.id)
					return { employee: arm?.employee, year: arm?.year, topic: arm?.topic }
				},
				PlanSetup: () => {
					const arm = plans.get(header.id)
					return { plan: arm?.plan, evidence: arm?.evidence }
				},
				Bookkeeping: () => ({ evidence: books.get(header.id)?.evidence }),
				TaxAccount: () => {
					const arm = accounts.get(header.id)
					return { account: arm?.account, evidence: arm?.evidence }
				}
			} satisfies Record<QuestionKind, () => Partial<Decoded>>
			return { ...base, kind: header.kind, ...arms[header.kind]() }
		})
	})

export const AskInput = Schema.Struct({
	...commandFields,
	subject: QuestionSubject,
	...inputFields(S.Question, ["detail"]),
	evidence: Schema.optional(Nonblank)
})
export const AnswerInput = Schema.Struct({
	...commandFields,
	question: Id,
	evidence: Nonblank
})

export const recordQuestion = (payload: unknown) =>
	Effect.gen(function* () {
		const input = parseStrict(AskInput, payload)
		return yield* businessCommand({
			request: input.request,
			business: input.business,
			action: "question ask",
			input: payload,
			plan: ({ draft, note }) =>
				Effect.gen(function* () {
					if (input.subject.kind !== "Review" && input.evidence === undefined)
						return yield* Effect.fail(
							new Refusal({
								code: "EvidenceRequired",
								message: `A ${input.subject.kind} question needs evidence`
							})
						)
					const question = yield* askQuestion(
						draft,
						note,
						input.business,
						input.subject,
						input.detail,
						input.evidence ?? input.detail
					)
					return { question }
				})
		})
	})

/** One answer closes a question; the same answer again is a no-change retry. */
export const answerQuestion = (payload: unknown) =>
	Effect.gen(function* () {
		const input = parseStrict(AnswerInput, payload)
		return yield* businessCommand({
			request: input.request,
			business: input.business,
			action: "question answer",
			input: payload,
			plan: ({ snapshot, draft, note }) =>
				Effect.gen(function* () {
					const question = (yield* questions(snapshot, input.business)).find(
						(row) => row.id === input.question
					)
					if (!question)
						return yield* Effect.fail(
							new Refusal({ code: "QuestionMissing", message: "No matching question for this business" })
						)
					if (question.answer)
						return yield* Effect.fail(
							new Refusal({ code: "QuestionAnswered", message: `Already answered by ${question.answer.id}` })
						)
					const answer = yield* mintId
					yield* draft.insert(S.Answer, [
						{ id: answer, question: question.id, evidence: yield* note(input.evidence) }
					])
					return { question: question.id, answer }
				})
		})
	})
