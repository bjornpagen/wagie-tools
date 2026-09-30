# wagie-tools

Payroll for the wagie who signs their own checks.

A local payroll and bookkeeping ledger for a single-owner S corporation.
TypeScript and Effect run a JSON operation interface over BumbleDB. The current
scope is federal payroll, Texas unemployment, ordinary owner distributions,
and employee Roth and after-tax retirement contribution bookkeeping.

The interface is three verbs and a table of named operations. `apply` takes one
write (`{"op": "payroll.post", …}`), `read` takes one read
(`{"read": "status", …}`), and `schema` prints every operation's JSON Schema.
Money crosses the boundary as dollars with two decimals, dates as
`YYYY-MM-DD`, and every integer's unit is fixed by its field name.

[Operating skill](SKILL.md)
· [Data model](src/schema.ts)
· [Numeric units](docs/units.md)
· [Runtime](docs/local-runtime.md)

## The model

Wages, tax assessments, bank movements, contributions, filings, and their
evidence are separate facts. Prose evidence is a Statement, stored once and
cited by id from every fact it justifies. Open questions are one header with
a typed arm per kind; an Answer closes them. UUIDv7 ids are the clock; there
are no timestamp columns. Keys, containment, closed relations, interval
relationships, and capacity constraints judge the final state of each write.
TypeScript inputs and query results derive their shapes from the schema.

Payroll calculations use dated policy stored in the database: tax bands,
wage bases, rates, rounding, contribution limits, and calendar coverage.
Native queries calculate band intersections and exact integer amounts.
Federal and state policy each need an explicit annual refresh. Missing
coverage blocks payroll; a previous year's values do not silently roll forward.

Every actual payroll or distribution transfer has a native Mercury transaction
ID. Cash allocations connect one movement to its uses without spending it twice.
A wage fully absorbed by deductions can explicitly require no bank transfer.
Employee FICA recovery follows the outstanding balance and available net pay.
A `RothOnly` calculation solves the gross that leaves exactly zero cash after
tax and the requested Roth, so a zero-cash Roth wire is one intent.

Withheld Roth blocks payroll until it has left the business: funded by a
Mercury movement whose sent receipt is attached. The plan provider's own
confirmation is tracked as a reminder and never gates payroll.

Money is integer cents inside the database and two-decimal dollars at the boundary. Civil dates use Unix epoch days; recording timestamps
use Unix milliseconds. TypeScript brands distinguish dates, instants, and day
counts. Entity and request IDs are UUIDv7. See the [units](docs/units.md).

## Work before wages

Forms have versions, preparation evidence, and an explicit submission method:
grandfathered, digital, or certified mail. Certified submissions require a
tracking number. Tax payments have their own evidence and reconciliation.

Status, upcoming deadlines, reports, and payroll admission read the same work
register. An unpaid tax obligation or an outstanding required filing can block
new payroll. Recording a completion changes the register used by every caller.

Retirement bookkeeping connects elections, contribution funding, provider
receipts, conversions, and supplied tax facts. It does not calculate 1099-R
amounts or shareholder basis. Sending money and submitting forms remain external
actions; the ledger records their evidence and outcomes.

## Run it

Use Node 24+ and the repository's pinned pnpm version:

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm cli schema
```

For an existing configured ledger:

```sh
echo '{"read": "db.audit"}' | pnpm cli read
echo '{"read": "status", "business": "BUSINESS_ID"}' | pnpm cli read
echo '{"read": "report", "business": "BUSINESS_ID", "year": 2026}' | pnpm cli read
```

`status` lists open work and payroll blockers; every item carries the `next`
operation and the input fields the ledger already knows. The
[operating skill](SKILL.md) has the recipes. Startup opens
`private/binding.json`; it never creates an empty replacement for a missing
database. The public repository contains synthetic test fixtures. A working
ledger needs its own company, employee, policy, election, and filing evidence.

## Durable commands and backups

Each write has a retained request identity, sealed command, and exact-state
precondition. Resolve an interrupted request before retrying it. Reusing its
identity for a different intent is refused.

The ignored `private/` directory holds the database (`private/binding.json`
names it) and retained write requests. Keep operational data out of Git.

A backup is one `.tar.xz` with the database only: `{"op": "db.backup", "output": …}`,
`db.verify-backup` and `db.restore` (see [SKILL.md](SKILL.md)). Verification
restores into a throwaway directory and compares every fact. Documents live in
Google Drive; the ledger keeps each one's Drive file id and SHA-256, and
`{"read": "artifact.audit", "verify": true}` re-checks them with rclone. Source
lives in Git. Neither is copied into a backup.

`migrations/0002-typed/` is the current database baseline. `migrations/index.ts`
is the table of every released step (source schema, target schema, cutover), and
`scripts/migrate.ts --step NAME` runs one against a live ledger as an explicit
native transition. BumbleDB Log 1.3.1 generates each snapshot and its
TypeScript bindings; a schema change is a handwritten transformation between
two generated bindings. See [migrations](docs/migrations.md).

## Development

```sh
pnpm check
```

The checks cover TypeScript, formatting, native schema constraints, payroll
arithmetic against an independent oracle, command recovery, filing evidence,
and backup/restore. Schema checking independently renders the current artifact
and compares it with the checked-in version.

After intentionally changing the schema:

```sh
pnpm schema:generate
pnpm check
```

This uses the published Log snapshot and binding generators. It does not modify
a business database. The initial baseline is fixed once released; create a new
snapshot and transformation for subsequent schema changes.

## Repository

- `src/schema.ts`, `src/schema/`: relations, constraints, vocabulary, boundary units, and input derivation.
- `src/ops.ts`: the operation table; `src/cli.ts`: `apply`, `read`, `schema`, `id`.
- `src/work-rules.ts`, `src/work.ts`, `src/bookkeeping-work.ts`: the work register as rules.
- `src/policy/`: annual qualifications and calendar policy.
- `src/`: domain commands, native queries, reports.
- `test/`: synthetic fixtures, independent arithmetic checks, and native lifecycle tests.
- `migrations/`: generated snapshots and bindings per baseline, and handwritten cutovers.
- `scripts/schema.ts`: verifies the current snapshot and bindings against the declaration.
- `SKILL.md`: instructions for operating a configured ledger.

## License

[0BSD](LICENSE).
