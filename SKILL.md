---
name: wagie-tools
description: Run payroll, wires, tax payments, filings, distributions and the mega backdoor Roth for Emu Farm LLC through the wagie-tools ledger's JSON ops.
---

# Wagie Tools

```sh
node src/cli.ts <op> '<json>'
node src/cli.ts                  # every op with a one-line summary
```

- Money is dollars with two decimals, as a string: `"8000.00"`, `"0.01"`.
- Days are `"YYYY-MM-DD"`. Periods are `"2026"`, `"2026Q3"` or `"2026-10"`.
- Unknown keys refuse. A refusal prints `{code, message}` and exits 1.
- Every write prints `"outcome": "committed"`, or `"no-change"` when the same
  facts are already there. Running a write twice is safe.

**The Tracking ID.** Every transfer is recorded by Mercury's Tracking ID: the
`Tracking ID` column of the Mercury CSV export, `YYYYMMDDMMQFMP4S######` for
wires and send-money transfers, a 15-digit ACH trace for IRS and TWC debits.
The transaction UUID on a wire receipt is not a Tracking ID and is refused.

**Start with `status`.** Its `blockers` are what stops payroll today, each with
the op that clears it; `upcoming` is what opens later; the rest is the year so
far (salary against target, Roth and after-tax room, distributions, payments,
credits, overpaid paychecks). Payroll is blocked until every blocker is gone.

## Payroll

1. `status` shows no blockers.
2. Quote the paycheck. `by` is `"plan"` (keeps the year on its salary target),
   `"gross"` with `gross`, or `"net"` with `net` (what lands after any
   recovery). `roth` is optional; `fit` defaults to the year's plan.

   ```sh
   node src/cli.ts payroll.quote '{"paidOn":"2026-10-09","input":{"by":"plan","roth":"500.00"}}'
   ```

3. Post it with the same input: `payroll.post`. It prints the wires to send.
4. Send both wires from Mercury: net pay to the owner, the Roth deferral to
   Carry Roth (QCRH000004).
5. Once they show as Sent, export the Mercury CSV and record each with its
   Tracking ID:

   ```sh
   node src/cli.ts transfer.record '{"kind":"NetPay","paidOn":"2026-10-09","mercury":"20261009MMQFMP4S000123","sentOn":"2026-10-09","amount":"1234.56"}'
   node src/cli.ts transfer.record '{"kind":"RothDeferral","paidOn":"2026-10-09","mercury":"20261009MMQFMP4S000124","sentOn":"2026-10-09","amount":"500.00"}'
   ```

## Federal deposit (EFTPS)

`status` lists each month's 941 deposit, due the 15th of the next month. Pay it
in EFTPS, and once the debit has posted in Mercury, export the Mercury CSV and
record the payment with its EFT number and the debit's Tracking ID:

```sh
node src/cli.ts tax.paid '{"tracker":"270667581302337","account":"Federal941","kind":"Deposit","period":"2026Q4","amount":"649.12","initiatedOn":"2026-11-12","mercury":"061036010012345","sentOn":"2026-11-13"}'
```

`period` is the quarter the deposit pays (the year for `Federal940`). `kind` is
`Deposit`, `Balance` (a balance due with a return or notice) or `Penalty` (a
notice's penalty or interest, which never counts toward tax).

## Texas UI (TWC)

The same, with account `TexasUI`, the quarter, and the TWC confirmation number
as `tracker`.

## Mega backdoor Roth

Wire the after-tax contribution from Mercury to Carry's Mega Backdoor Roth
account (QCEP000007), then record it with the Carry contribution year. It is an
S-corp distribution, and Carry converts it in-plan.

```sh
node src/cli.ts transfer.record '{"kind":"AfterTax","year":2026,"mercury":"20261015MMQFMP4S000200","sentOn":"2026-10-15","amount":"5000.00"}'
```

## Distribution

```sh
node src/cli.ts transfer.record '{"kind":"Distribution","mercury":"20261015MMQFMP4S000201","sentOn":"2026-10-15","amount":"8000.00"}'
```

## Quarter end

1. `node src/cli.ts report '{"year":2026,"quarter":4}'` prints every line of
   the 941 and the C-3.
2. Prepare both from it. Mail the 941 by certified mail; file the C-3 online.
   Keep the PDFs and the USPS receipt in Drive.
3. Record them. The figures stored are the report's; if the return differs,
   fix the ledger first.

   ```sh
   node src/cli.ts filing.record '{"form":"F941","period":"2026Q4","method":"CertifiedMail","mailedOn":"2027-01-20","tracking":"70201810000002650241"}'
   node src/cli.ts filing.record '{"form":"C3","period":"2026Q4","method":"Electronic","on":"2027-01-15","confirmation":"40679135"}'
   ```

## Year end

`report '{"year":2026}'` prints the 940, W-2, W-3 and, when there was plan
activity (after-tax contributions or a `plan.distribution`), the 1099-R and
1096. Pay any FUTA balance (`tax.paid`, `Federal940`). Each form takes the
methods it allows:

| Form | Method |
|---|---|
| `F941`, `F940`, `F1096` | `CertifiedMail` |
| `W3` | `CertifiedMail` or `Electronic` (SSA BSO) |
| `C3` | `Electronic` |
| `W2`, `F1099R` | `Furnished` (the recipient's copy, with the day it was given) |

```sh
node src/cli.ts filing.record '{"form":"W2","period":"2026","method":"Furnished","on":"2027-01-20"}'
```

A Carry rollover (H) or conversion (G) other than the after-tax conversions
needs its 1099-R figures recorded:

```sh
node src/cli.ts plan.distribution '{"year":2026,"account":"Roth","code":"H","gross":"1000.00","taxable":"0.00"}'
```

From December 1, `status` lists next year's setup: `year.set` (rates, wage
bases and limits), `plan.set` (salary target and FIT per paycheck) and
`election.set` (the signed Carry election).

## Correction

`payroll.correct` reprices a posted paycheck over the same earnings start:
`fit` or `roth` on any paycheck, `gross` only on the year's latest. Then follow
the blockers:

- underpaid: wire the difference and `transfer.record` it as `NetPay`;
- overpaid: nothing to do; the next `payroll.post` recovers it;
- a deposit short: pay it;
- a filed quarter changed: mail a 941-X and record it with
  `filing.amend '{"period":"2026Q3","mailedOn":"…","tracking":"…"}'`.

A grandfathered filing whose real details turn up takes them with
`filing.upgrade`, with the same input as `filing.record`.

## Backup

```sh
node src/cli.ts export        # private/Wagie Tools - CURRENT.facts.json
```

`import '{"file":"…"}'` restores an export into a fresh ledger.
