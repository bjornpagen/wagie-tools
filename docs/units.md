# Units and calendar conventions

Wagie Tools uses three different time types. TypeScript brands prevent mixing them.

| Type | Meaning | Example |
| --- | --- | --- |
| `UnixEpochMilliseconds` | Signed milliseconds since 1970-01-01 00:00:00 UTC; the POSIX/JavaScript convention excludes leap seconds | Recording and verification timestamps |
| `UnixEpochDay` | A Gregorian calendar date, numbered from 1970-01-01 = 0; 1969-12-31 = -1 | Pay date, mailing date, deadline |
| `CalendarDays` | A count of calendar-date steps | The length of a work period |

A civil-day interval is half-open: `[start, end)`. January covers January 1
through January 31, with February 1 as its exclusive end. February can have 28
or 29 days. Civil days across daylight-saving transitions still count as one
calendar date even when the local day has 23 or 25 elapsed hours.

The day coordinate is not Julian Day Number. As described in
[Julian day](https://en.wikipedia.org/wiki/Julian_day), JDN starts at noon with
an epoch in 4713 BC. It also differs from Modified Julian Date and day-of-year.
Wagie Tools's coordinate starts with the Gregorian date 1970-01-01, uses whole
calendar dates, and has no fractional-day component. UTC midnight is used only
to convert the date's year/month/day to its numerical coordinate. A date by
itself does not specify a time zone or identify an instant.

The current payroll recording day comes from the real clock converted into
the business's named time zone. It is never obtained by dividing a local
midnight timestamp by 86,400,000. A requested pay date cannot replace the
recording day to bypass already-open work.

Stored recording timestamps use native `i64` Unix milliseconds. Stored business
dates and their interval endpoints use native `i64` epoch days. Human-readable
date strings are confined to input, display, and preserved source evidence.
Pay dates shared by wages, assessment sets, revisions, and applied rules are
fixed-width one-day intervals `[day, day + 1)`. This gives the database one date
representation for both exact ownership matches and membership in a policy or
tax-year span; there is no separately writable scalar copy of that pay date.
The database adapter parses the native integer back into the corresponding
branded type before using calendar operations.

Money uses integer cents. Wage-base intervals have native `u64` cent coordinates;
their measured widths are cents. A rate has an integer numerator and a positive
integer denominator. A zero-rate band may still contain taxable wages. Rounding
is performed once per component per wage using native integer arithmetic.
