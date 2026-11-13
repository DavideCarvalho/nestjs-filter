---
"@dudousxd/nestjs-filter": minor
---

Add the `filter_explain_query` MCP dev tool. `FilterModule` registers it in the Aviary dev-tools slot (`Symbol.for('@dudousxd/aviary:dev-tools')`, created when absent) without an `authorize`, so the agent dev endpoint's `devTools.authorize` gates it (open outside production, denied in production without it); a hub that cannot gate console-less libs leaves it out. Given a filter class name and a query string, it dry-runs the request with no database: what the server parses, the conditions it generates, why it would fail, and what the filter silently drops. Each filter has a unique id (its class name, or `Name@Controller.handler` / `Name#n` when several filters share a class name); an ambiguous name answers with the candidate ids. `devTools: false` turns it off. The same dry run is available as `FilterRunner.explain(FilterClass, input)`, with `decodeQueryString(query)`.
