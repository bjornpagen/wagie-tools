---
name: wagie-tools
description: Run payroll, wires, tax payments, filings, distributions, the mega backdoor Roth and the plan's rollovers for a single-owner S corporation through the wagie-tools ledger's JSON ops.
---

# Wagie Tools

```sh
node src/cli.ts <op> '<json>'
node src/cli.ts                  # every op with a one-line summary
```

- Money is dollars with two decimals, as a string: `"8000.00"`, `"0.01"`.
- Rates are percents, as a string: `"6.2"`, `"1.45"`.
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
far (salary against target, Roth and after-tax room, Roth basis awaiting a
sweep, distributions, payments, credits, overpaid paychecks, filed figures that
no longer match, each naming `filing.correct` when a correction fixes it).
Payroll is blocked until every blocker is gone.

## Setup

`setup` creates the ledger once: the employer, the employee and the plan (each
with name, TIN and address), the state registrations, where and since when the
owner works, and the Carry account holding each plan account.

```sh
node src/cli.ts setup '{"employer":{"name":"…","tin":"…","address":"…"},"employee":{…},"plan":{…},"registrations":[{"state":"TX","number":"…"}],"employment":{"from":"2026-01-02","state":"TX"},"custody":{"Pretax":{"custodian":"Carry","number":"…"},"AfterTax":{…},"Roth":{…}}}'
```

## Each year's policy

From December 1, `status` shows next year's policy as upcoming; from January 1
it blocks. Set it per jurisdiction, each time whole:

```sh
node src/cli.ts policy.set '{"jurisdiction":"Federal","year":2027,"limits":{"deferralLimit":"…","additionsLimit":"…","compensationLimit":"…","wageCeiling":"200000.00"},"rates":{"SocialSecurity":{"rate":"6.2","base":"…"},"Medicare":{"rate":"1.45"},"FederalUnemployment":{"rate":"0.6","base":"7000.00"}}}'
node src/cli.ts policy.set '{"jurisdiction":"TX","year":2027,"rates":{"TexasUnemployment":{"rate":"…","base":"9000.00"}}}'
node src/cli.ts election.set '{"year":2027,"roth":"…","afterTax":"…","signedOn":"…"}'
node src/cli.ts plan.set '{"year":2027,"salary":"…","fitPerCheck":"0.01"}'
```

A rate without a `base` taxes every dollar. The Roth and after-tax elections
together stay within the year's 415(c) limit. Once a paycheck has withheld social
security or Medicare, neither band can change in a way that would withhold it
differently; an employer's own rate (FUTA, Texas UI) can, and its returns
follow.

## Payroll

1. `status` shows no blockers.
2. Quote the paycheck. `by` is `"plan"` (keeps the year on its salary target),
   `"gross"` with `gross`, or `"net"` with `net` (what lands after any
   recovery). `roth` is optional; `fit` defaults to the year's plan.

   ```sh
   node src/cli.ts payroll.quote '{"paidOn":"2026-10-09","input":{"by":"plan","roth":"500.00"}}'
   ```

3. Post it with the same input: `payroll.post`. It prints the wires to send.
   Roth comes out of pay only from the day the year's election was signed, and
   no paycheck joins a period whose return is already filed.
4. Send both wires from Mercury: net pay to the owner, the Roth deferral to the
   Carry Roth account the wire names.
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
node src/cli.ts tax.paid '{"tracker":"270000000000001","account":"Federal941","kind":"Deposit","period":"2026Q4","amount":"612.34","initiatedOn":"2026-11-12","mercury":"061036010000001","sentOn":"2026-11-13"}'
```

`period` is the quarter the deposit pays (the year for `Federal940`). `kind` is
`Deposit`, `Balance` (a balance due with a return, a 941-X or a notice) or
`Penalty` (a notice's penalty or interest, which never counts toward tax).

Once a quarter's 941 is filed, the months on its line 16 are what the quarter
owes, whatever a later recompute says.

## Texas UI (TWC)

The same, with account `TexasUI`, the quarter, and the TWC confirmation number
as `tracker`.

## Mega backdoor Roth

Wire the after-tax contribution from Mercury to the Carry after-tax account,
then record it with the plan's contribution year. It is an S-corp
distribution, and Carry converts it to Roth as it settles, so the conversion
goes on the 1099-R for the year the wire was sent, even when it counts toward
the year before.

```sh
node src/cli.ts transfer.record '{"kind":"AfterTax","year":2026,"mercury":"20261015MMQFMP4S000200","sentOn":"2026-10-15","amount":"5000.00"}'
```

A wire past `status`'s `afterTax.room` refuses: what the election leaves, and
415(c), the year's pay with the salary target standing in for pay to come.

## Rollover

Every rollover sweeps a whole account into the owner's Roth IRA. Record each
with the day and the amount that left. The basis it carries (the Roth deferral
and after-tax wires since the last sweep), the part of that basis from
conversions made in the last five years (1099-R box 10), and its 1099-R lines
follow. The after-tax account is never swept by hand: Carry converts it.

```sh
node src/cli.ts plan.rollover '{"account":"Roth","on":"2026-11-02","gross":"25000.00"}'
```

## Distribution

```sh
node src/cli.ts transfer.record '{"kind":"Distribution","mercury":"20261015MMQFMP4S000201","sentOn":"2026-10-15","amount":"8000.00"}'
```

## Quarter end

1. `node src/cli.ts report '{"year":2026,"quarter":4}'` prints every line of
   the 941 and the C-3, headed by who they name.
2. Prepare both from it. Mail the 941 by certified mail; file the C-3 online.
3. Record them. The figures stored are the report's; if the return differs,
   fix the ledger first. A return is recorded only once its period is over;
   recording it again is no change.

   ```sh
   node src/cli.ts filing.record '{"form":"F941","period":"2026Q4","method":"CertifiedMail","mailedOn":"2027-01-20","tracking":"9400100000000000000001"}'
   node src/cli.ts filing.record '{"form":"C3","period":"2026Q4","method":"Electronic","on":"2027-01-15","confirmation":"12345678"}'
   ```

## Year end

`report '{"year":2026}'` prints the 940, W-2, W-3 and, when there was plan
activity (after-tax contributions or a rollover), the 1099-R and 1096, with the
policy in force and the year's sweeps. Pay any FUTA balance (`tax.paid`,
`Federal940`). Each form takes the methods it allows:

| Form | Method |
|---|---|
| `F941`, `F940`, `F1096` | `CertifiedMail` |
| `W3` | `CertifiedMail` or `Electronic` (SSA BSO) |
| `C3` | `Electronic` |
| `W2`, `F1099R` | `Furnished` (the recipient's copy, with the day it was given) |

```sh
node src/cli.ts filing.record '{"form":"W2","period":"2026","method":"Furnished","on":"2027-01-20"}'
```

## Correction

`payroll.correct` reprices a posted paycheck: `fit` or `roth` on any paycheck,
`gross` only on the year's latest. Social security and Medicare move only with
gross. Then follow the blockers:

- underpaid: wire the difference and `transfer.record` it as `NetPay`;
- overpaid: nothing to do; the next `payroll.post` recovers it;
- a deposit short: pay it;
- a filed quarter's wages or FIT changed: the quarter's `report` shows the
  941-X under `forms.F941.correctionDue`, each line as filed and as it should
  be, with column 4 and line 27. Mail it by certified mail, record it, then pay
  its line 27 as a `Balance`:

  ```sh
  node src/cli.ts filing.correct '{"form":"F941","period":"2026Q3","mailedOn":"…","tracking":"…"}'
  ```

A filed 1099-R that no longer matches the plan's books shows in `status` under
`mismatches`; it doesn't block payroll. The year's `report` shows the
correction under `forms.F1099R.correctionDue`: each box that changes, and the
1096 that transmits the corrected forms (`count`, and `gross`, their box 1
total). Prepare each form with a changed box again, marked CORRECTED, with
every box as `forms.F1099R.lines` shows it. Mail Copy A with the new 1096 by
certified mail, give the owner Copy B, and record it:

```sh
node src/cli.ts filing.correct '{"form":"F1099R","period":"2025","mailedOn":"…","tracking":"…"}'
```

A correction restates only the lines that changed; the rest stand as filed. It
is mailed after the return it corrects, under a tracking number of its own. A
return takes one correction. Once corrected 1099-Rs are recorded, the original
1096 stands as filed and leaves `mismatches`.

## Backup

```sh
node src/cli.ts export        # private/Wagie Tools - CURRENT.facts.json
```

`import '{"file":"…"}'` restores an export into a fresh ledger, and refuses
anything `export` wouldn't write, leaving no ledger behind. An import is
also how history enters: the span the ledger did not record, the filings
attested inside it, and payments made outside Mercury.
