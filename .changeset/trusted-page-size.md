---
'@dudousxd/nestjs-filter': minor
---

Let a trusted server-side call opt out of `maxPageSize`.

`maxPageSize` is configured once, on the module, and then has to answer two questions that want different answers. For a `size` that arrived on an HTTP request the cap is the whole point — it is what stops a client asking for a million rows. For a `size` the server itself wrote, it is not protection but a silent wrong answer: an export asks for 10 000 rows, is handed 100, reads `100 < 10 000` as "the table is exhausted", and writes a truncated CSV with nothing logged and nothing thrown. The runner cannot tell the two apart by looking at the number, so the only consumer that could opt out — trusted code — was the one that could not.

`findAndCount(entity, input, { trustedPageSize: true })` is the escape hatch, with the same option on `findPage` (lifting the cap off `first`/`last`) and on `applyDynamic`'s per-call `internal` bag for callers that build the query themselves. Nothing changes when it is not passed: the global cap still applies everywhere, which is the behaviour every existing call keeps.

It is a boolean, not a numeric per-call `maxPageSize`, because a number does not solve the problem it looks like it solves. The caller would have to invent a second ceiling that must be at least as large as the size it is already passing, and guessing it low reproduces the exact silent truncation the option exists to remove — one call site, two numbers that must agree, no error when they don't. The fact the call site actually holds is not a better ceiling; it is *this size did not come from a client*, which is one bit. `trustedPageSize: true` also reads as what it is at a glance, where `maxPageSize: 10_000` sitting in an options object reads like ordinary config and could as easily be tightening the cap as lifting it.

Deliberately absent from `apply()`: that is the filter-class path `@ApplyFilter` drives, where the input is the HTTP request by definition, and a trust flag travelling next to route-bound client input is the confusion this is trying to prevent. The minimum page size of 1 still applies to trusted calls — that one is a correctness floor (`LIMIT 0` is not a page), not a safety cap.
