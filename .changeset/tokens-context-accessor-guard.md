---
"@dudousxd/nestjs-filter": patch
---

Note what pins the CONTEXT_ACCESSOR token key

Comment-only change. The `CONTEXT_ACCESSOR` docblock said the symbol key must
stay byte-identical with `@dudousxd/nestjs-context`'s export but did not say
what enforces that. It now names the guard: `test/capability-naming.spec.ts`
pins the token against `capability('context', 'accessor')` from
`@dudousxd/nestjs-diagnostics`. No runtime behavior changes.
