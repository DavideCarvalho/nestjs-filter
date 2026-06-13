---
"@dudousxd/nestjs-filter": patch
"@dudousxd/nestjs-filter-mikro-orm": patch
"@dudousxd/nestjs-filter-typeorm": patch
---

Fix pure OR/AND group nodes (global-search OR-of-iContains). The client builder
serializes an OR/AND group as `{ field: "", operator: "equals", OR: [...] }`
(empty field), but `validateColumnFilter` rejected the empty field and the
mikro-orm/typeorm resolvers emitted a broken base condition for it. Now a node
with `AND`/`OR` and no (or empty) `field` is treated as a pure group: validation
skips field/operator/value and recurses into the arrays, and the resolvers
contribute only the nested conditions. Unblocks `.or(...)`/`.and(...)` and
multi-column global search.
