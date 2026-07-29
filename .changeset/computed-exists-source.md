---
'@dudousxd/nestjs-filter-mikro-orm': patch
'@dudousxd/nestjs-filter-typeorm': patch
---

A computed source written as `EXISTS (…)` is now parenthesized like a `SELECT` one.

`EXISTS (…)` / `NOT EXISTS (…)` is the natural way to write "does this row have any …?", and it was the one subquery shape the adapters did not normalize — only a source starting with `SELECT` got wrapped in `( … )`.

Be precise about what this buys, because the obvious claim does not hold: an unwrapped `EXISTS (…) = ?` is **not** broken on the engines tested. The behavioural cases in the new spec pass with and without the parentheses on SQLite, since `EXISTS` yields 0/1 and the comparison parses as intended. This is normalization, not a repair.

What it does buy is safe composition wherever an adapter embeds the source into a LARGER expression instead of using it standalone. The concrete case is `groupByCount`'s bucketed variant, which wraps it in arithmetic and a function call (`floor(<expr> / ?) * ?`); a bare predicate there relies on operator precedence rather than on parentheses being present. Treating both subquery shapes identically removes the question, and stops the rule "a bare subquery source is wrapped for you" from having a silent exception.

Declare such a field `type: 'boolean'` and filter it with `equals true` / `equals false`. A count (`SELECT COUNT(*) …` with `gt 0`) is still the more portable spelling where the caller controls both sides — booleans are where the dialects diverge most (`= 1` on MySQL, `= true` on PostgreSQL).
