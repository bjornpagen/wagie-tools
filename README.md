# wagie-tools

Payroll for the wagie who signs their own checks.

A local payroll and bookkeeping ledger for a single-owner S corporation.
TypeScript and Effect run a noninteractive CLI over BumbleDB. The current
scope is federal payroll, Texas unemployment, ordinary owner distributions,
and employee Roth and after-tax retirement contribution bookkeeping.

[Operating skill](SKILL.md)
· [Data model](src/schema.ts)
· [Numeric units](docs/units.md)
· [Runtime](docs/local-runtime.md)

## The model

Wages, tax assessments, bank movements, contributions, filings, and their
evidence are separate facts. Keys, containment, closed relations, interval
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

Money uses integer cents. Civil dates use Unix epoch days; recording timestamps
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
pnpm cli --help
```

Operations use JSON inputs and return JSON results. The [operating skill](SKILL.md)
covers payroll, distributions, retirement records, tax work, policy, and backups.
For an existing configured ledger:

```sh
pnpm cli db audit
pnpm cli status --business BUSINESS_ID
pnpm cli deadlines --business BUSINESS_ID
pnpm cli report year --business BUSINESS_ID --year YEAR
```

Replace placeholders with IDs and periods from the ledger. Startup opens
`private/binding.json`; it never creates an empty replacement for a missing
database. The public repository contains synthetic test fixtures. A working
ledger needs its own company, employee, policy, election, and filing evidence.

## Durable commands and backups

Each write has a retained request identity, sealed command, and exact-state
precondition. Resolve an interrupted request before retrying it. Reusing its
identity for a different intent is refused.

The ignored `private/` directory holds the database, command recovery, provenance,
and evidence. Keep operational data out of Git. Native backup verification
restores into an isolated history and compares every fact. Replacing a current
backup also requires downloading and verifying the published bytes.

`migrations/0000-initial/` is the canonical initial database baseline. BumbleDB
Log 1.3.1 generates its native schema snapshot and TypeScript bindings. Fresh
histories use that snapshot; the initial cutover copies existing facts through
native unpublished population. Future schema changes use ordinary TypeScript
transformations and explicit native transitions. See [migrations](docs/migrations.md).

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

- `src/schema.ts`, `src/schema/`: relations, constraints, vocabulary, and input derivation.
- `src/policy/`: annual qualifications and calendar policy.
- `src/`: domain commands, native queries, reports, and the CLI.
- `test/`: synthetic fixtures, independent arithmetic checks, and native lifecycle tests.
- `migrations/0000-initial/`: canonical snapshot, generated bindings, and the initial fact-preserving cutover.
- `scripts/schema.ts`: verifies the snapshot and bindings against the current declaration.
- `SKILL.md`: instructions for operating a configured ledger.

## License

[0BSD](LICENSE).
