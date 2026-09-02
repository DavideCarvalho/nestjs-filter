---
'@dudousxd/nestjs-filter': patch
---

Structured input on a GET works on Express's default query parser again

Express 5 changed its default `query parser` from `qs` ("extended") to `simple`, which does no
nesting and no arrays. A structured query travels on a GET as bracket notation
(`filter[where][0][field]=status`), so under NestJS 12 those arrive as literal flat keys — and the
library read them as unrecognised input.

That failed in the worst direction: the keys carrying the predicates were simply not recognised, so
the query ran **unfiltered** and answered with every row, 200 and all. Nothing logged, nothing threw.
`groupByCount`/`extent`/`histogram` were worse still — their spec key never arrived either, so the
request was rejected as malformed.

The runner now expands bracket-encoded keys itself, before anything reads the structured sections. A
host whose parser already nested them (Express 4, `app.set('query parser', 'extended')`, Fastify, or
any JSON body) is unaffected — the input is returned by reference, untouched.

The example app's e2e suite has always set `query parser` to `extended` to work around this. A new
spec runs the same requests **without** it, so the default-parser path stays covered.
