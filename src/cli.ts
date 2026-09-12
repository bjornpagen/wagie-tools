import { NativeRuntime, query, v } from "@bjornpagen/bumbledb"
import type { TerminalReceipt } from "@bjornpagen/bumbledb-log"
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Console, Effect, Option, type Scope } from "effect"
import { CliConfig, Command, Flag, GlobalFlag } from "effect/unstable/cli"
import { auditLedger } from "./audit.ts"
import { backupLedger, restoreArchive, verifyArchive } from "./backup.ts"
import { recordBookkeeping } from "./bookkeeping.ts"
import { io, readText } from "./core/files.ts"
import { civilDaySpan, parseCalendarDate, today } from "./core/time.ts"
import { entityId, json, Refusal } from "./core/values.ts"
import { locateArtifact, recordArtifact, recordMailing, verifyArtifact } from "./evidence.ts"
import { ensureFilings, expectRetirementFiling } from "./filing-coverage.ts"
import {
	amendFiling,
	inspectFilings,
	prepareFiling,
	rejectFiling,
	reviseDeadline,
	submitFiling
} from "./filings.ts"
import { disposeLiability, reconcilePayments, recordPayment } from "./payments.ts"
import {
	calculatePayroll,
	inspectCalculation,
	payrollReadback,
	postPayroll,
	revisePayrollTax
} from "./payroll.ts"
import {
	recordAnnualEvidence,
	recordAnnualPolicy,
	recordElectionDocument,
	refreshPolicy
} from "./policy/annual.ts"
import { activatePolicy, inspectPolicy, installPolicy } from "./policy/install.ts"
import {
	assignCompensation,
	configureBusiness,
	inspectProfiles,
	listReviews,
	recordBudget,
	recordElection,
	recordEmployee,
	resolveReview
} from "./profiles.ts"
import { rows } from "./queries.ts"
import { recordRecovery } from "./recoveries.ts"
import { report } from "./reports.ts"
import { defaultBindingPath, type Ledger, latest, ledgerLayer, resolveRequest } from "./runtime.ts"
import * as S from "./schema.ts"
import { suggestGross } from "./suggestions.ts"
import { workRegister } from "./work.ts"

const businessFlag = Flag.string("business").pipe(Flag.map(entityId))
const bindingFlag = Flag.string("binding").pipe(Flag.withDefault(defaultBindingPath))
const readFlags = {
	business: businessFlag,
	binding: bindingFlag,
	asOf: Flag.string("as-of").pipe(Flag.optional)
}
const businessClock = query(S.ledger).rule((r) => {
	const { timeZone } = v(S.Business)
	return r.match(S.Business, { id: r.param("business"), timeZone }).find({ timeZone })
})
const output = (value: unknown) => Console.log(json(value))

const inspect = (input: {
	business: ReturnType<typeof entityId>
	binding: string
	asOf: Option.Option<string>
}) =>
	Effect.gen(function* () {
		const snapshot = yield* latest
		const company = (yield* rows(snapshot, businessClock, { business: input.business }))[0]
		if (!company)
			return yield* Effect.fail(
				new Refusal({ code: "BusinessMissing", message: `No business ${input.business}` })
			)
		const asOf = Option.isSome(input.asOf)
			? parseCalendarDate(input.asOf.value)
			: yield* today(company.timeZone)
		return { snapshot, asOf }
	})

const status = Command.make("status", readFlags, (input) =>
	Effect.gen(function* () {
		const { snapshot, asOf } = yield* inspect(input)
		yield* output(yield* workRegister(snapshot, input.business, asOf))
	}).pipe(Effect.scoped, Effect.provide(ledgerLayer(input.binding)))
)

const deadlines = Command.make("deadlines", readFlags, (input) =>
	Effect.gen(function* () {
		const { snapshot, asOf } = yield* inspect(input)
		const register = yield* workRegister(snapshot, input.business, asOf)
		yield* output({ ...register, work: register.work.filter((row) => row.completion !== "Complete") })
	}).pipe(Effect.scoped, Effect.provide(ledgerLayer(input.binding)))
)

const yearReport = Command.make("year", { ...readFlags, year: Flag.integer("year") }, (input) =>
	Effect.gen(function* () {
		const { snapshot, asOf } = yield* inspect(input)
		yield* output(yield* report(snapshot, input.business, input.year, undefined, asOf))
	}).pipe(Effect.scoped, Effect.provide(ledgerLayer(input.binding)))
)
const quarterReport = Command.make(
	"quarter",
	{ ...readFlags, year: Flag.integer("year"), quarter: Flag.integer("quarter") },
	(input) =>
		Effect.gen(function* () {
			const { snapshot, asOf } = yield* inspect(input)
			yield* output(yield* report(snapshot, input.business, input.year, input.quarter, asOf))
		}).pipe(Effect.scoped, Effect.provide(ledgerLayer(input.binding)))
)
const reports = Command.make("report").pipe(Command.withSubcommands([yearReport, quarterReport]))

const resolve = Command.make(
	"resolve",
	{ binding: bindingFlag, request: Flag.string("request").pipe(Flag.map(entityId)) },
	(input) =>
		Effect.gen(function* () {
			const result = yield* resolveRequest(input.request)
			yield* output(result)
			if (result.kind !== "found" || !["committed", "no-change"].includes(result.receipt.outcome.kind))
				process.exitCode = 1
		}).pipe(Effect.scoped, Effect.provide(ledgerLayer(input.binding)))
)
const commands = Command.make("command").pipe(Command.withSubcommands([resolve]))

const mutation = <E, E2 = never>(
	name: string,
	run: (payload: unknown) => Effect.Effect<TerminalReceipt, E, Ledger | NativeRuntime | Scope.Scope>,
	readback?: (receipt: TerminalReceipt) => Effect.Effect<unknown, E2, Ledger | NativeRuntime | Scope.Scope>
) =>
	Command.make(name, { binding: bindingFlag, input: Flag.string("input") }, (input) =>
		Effect.gen(function* () {
			const text =
				input.input === "-"
					? yield* io("read JSON from stdin", async () => {
							const chunks: Buffer[] = []
							for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk))
							return Buffer.concat(chunks).toString("utf8")
						})
					: yield* readText(input.input)
			const receipt = yield* run(JSON.parse(text))
			yield* output(readback ? yield* readback(receipt) : receipt)
			if (
				(receipt.outcome.kind === "committed" || receipt.outcome.kind === "no-change") &&
				receipt.outcome.result.kind === "ReconciliationRequired"
			)
				process.exitCode = 1
		}).pipe(Effect.scoped, Effect.provide(ledgerLayer(input.binding)))
	)

const payments = Command.make("payment").pipe(
	Command.withSubcommands([
		mutation("record", recordPayment),
		mutation("reconcile", reconcilePayments),
		mutation("dispose", disposeLiability)
	])
)

const artifacts = Command.make("artifact").pipe(
	Command.withSubcommands([
		mutation("record", recordArtifact),
		mutation("locate", locateArtifact),
		mutation("verify", verifyArtifact)
	])
)
const mailings = Command.make("mailing").pipe(Command.withSubcommands([mutation("record", recordMailing)]))
const filings = Command.make("filings").pipe(
	Command.withSubcommands([
		mutation("ensure", ensureFilings),
		mutation("expect-retirement", expectRetirementFiling),
		Command.make("inspect", readFlags, (input) =>
			Effect.gen(function* () {
				const { snapshot, asOf } = yield* inspect(input)
				yield* output(yield* inspectFilings(snapshot, input.business, asOf))
			}).pipe(Effect.scoped, Effect.provide(ledgerLayer(input.binding)))
		),
		mutation("prepare", prepareFiling),
		mutation("submit", submitFiling),
		mutation("reject", rejectFiling),
		mutation("deadline", reviseDeadline),
		mutation("amend", amendFiling)
	])
)

const payroll = Command.make("payroll").pipe(
	Command.withSubcommands([
		mutation("calculate", calculatePayroll, payrollReadback),
		mutation("post", postPayroll, payrollReadback),
		mutation("revise-tax", revisePayrollTax, payrollReadback),
		Command.make(
			"inspect",
			{
				business: businessFlag,
				binding: bindingFlag,
				calculation: Flag.string("calculation").pipe(Flag.map(entityId))
			},
			(input) =>
				Effect.gen(function* () {
					yield* output(yield* inspectCalculation(yield* latest, input.business, input.calculation))
				}).pipe(Effect.scoped, Effect.provide(ledgerLayer(input.binding)))
		)
	])
)

const profileRead = (
	name: string,
	read: typeof inspectProfiles | typeof listReviews | typeof inspectPolicy
) =>
	Command.make(name, { business: businessFlag, binding: bindingFlag }, (input) =>
		Effect.gen(function* () {
			yield* output(yield* read(yield* latest, input.business))
		}).pipe(Effect.scoped, Effect.provide(ledgerLayer(input.binding)))
	)
const businessCommands = Command.make("business").pipe(
	Command.withSubcommands([mutation("configure", configureBusiness), profileRead("inspect", inspectProfiles)])
)
const employeeCommands = Command.make("employee").pipe(
	Command.withSubcommands([mutation("record", recordEmployee), profileRead("list", inspectProfiles)])
)
const compensation = Command.make("compensation").pipe(
	Command.withSubcommands([
		mutation("budget", recordBudget),
		mutation("assign", assignCompensation),
		profileRead("inspect", inspectProfiles),
		Command.make(
			"suggest",
			{
				business: businessFlag,
				binding: bindingFlag,
				employee: Flag.string("employee").pipe(Flag.map(entityId)),
				paidOn: Flag.string("paid-on").pipe(Flag.map(parseCalendarDate)),
				start: Flag.string("work-start").pipe(Flag.map(parseCalendarDate)),
				end: Flag.string("work-end-exclusive").pipe(Flag.map(parseCalendarDate))
			},
			(input) =>
				Effect.gen(function* () {
					const { snapshot, asOf } = yield* inspect({ ...input, asOf: Option.none() })
					yield* output(
						yield* suggestGross(
							snapshot,
							input.business,
							input.employee,
							civilDaySpan(input.start, input.end),
							input.paidOn,
							asOf
						)
					)
				}).pipe(Effect.scoped, Effect.provide(ledgerLayer(input.binding)))
		)
	])
)
const election = Command.make("election").pipe(
	Command.withSubcommands([mutation("record", recordElection), mutation("document", recordElectionDocument)])
)
const recovery = Command.make("recovery").pipe(Command.withSubcommands([mutation("record", recordRecovery)]))
const review = Command.make("review").pipe(
	Command.withSubcommands([mutation("resolve", resolveReview), profileRead("list", listReviews)])
)
const policy = Command.make("policy").pipe(
	Command.withSubcommands([
		mutation("install", installPolicy),
		mutation("annual", recordAnnualPolicy),
		mutation("evidence", recordAnnualEvidence),
		mutation("refresh", refreshPolicy),
		mutation("activate", activatePolicy),
		profileRead("inspect", inspectPolicy)
	])
)
const operationFlag = Flag.string("operation").pipe(Flag.map(entityId))
const db = Command.make("db").pipe(
	Command.withSubcommands([
		Command.make("audit", { binding: bindingFlag, asOf: Flag.string("as-of").pipe(Flag.optional) }, (input) =>
			Effect.gen(function* () {
				const asOf = Option.isSome(input.asOf) ? parseCalendarDate(input.asOf.value) : yield* today("UTC")
				yield* output(yield* auditLedger(yield* latest, asOf))
			}).pipe(Effect.scoped, Effect.provide(ledgerLayer(input.binding)))
		),
		Command.make(
			"backup",
			{ binding: bindingFlag, operation: operationFlag, output: Flag.string("output") },
			(input) =>
				Effect.gen(function* () {
					yield* output(yield* backupLedger(input))
				}).pipe(Effect.scoped, Effect.provide(ledgerLayer(input.binding)))
		),
		Command.make("verify-backup", { archive: Flag.string("archive") }, (input) =>
			Effect.gen(function* () {
				yield* output(yield* verifyArchive(input.archive))
			})
		),
		Command.make(
			"restore",
			{
				operation: operationFlag,
				archive: Flag.string("archive"),
				directory: Flag.string("directory"),
				bindingOutput: Flag.string("binding-output")
			},
			(input) =>
				Effect.gen(function* () {
					yield* output(yield* restoreArchive(input))
				})
		)
	])
)

export const cli = Command.make("wagie-tools").pipe(
	Command.withSubcommands([
		status,
		deadlines,
		reports,
		commands,
		mutation("bookkeeping", recordBookkeeping),
		payments,
		artifacts,
		mailings,
		filings,
		payroll,
		businessCommands,
		employeeCommands,
		compensation,
		election,
		recovery,
		review,
		policy,
		db
	])
)

const main = Command.run(cli, { version: "1.0.0", renderErrors: false }).pipe(
	Effect.provide(
		CliConfig.layer({ builtIns: [GlobalFlag.Help, GlobalFlag.Version, GlobalFlag.Completions] })
	),
	Effect.provide(NodeServices.layer),
	Effect.provide(NativeRuntime.layer()),
	Effect.catchCause((cause) =>
		Effect.gen(function* () {
			yield* Console.error(json(cause))
			process.exitCode = 1
		})
	)
)
NodeRuntime.runMain(main)
