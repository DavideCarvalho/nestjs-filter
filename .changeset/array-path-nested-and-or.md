---
"@dudousxd/nestjs-filter-mikro-orm": patch
---

Fix JSON array-path filters (`a.b[].c`) being ignored when nested inside an `AND`/`OR` group.

Array-path compilation only ran for top-level `where` filters; a path nested under another filter's `AND`/`OR` fell through to the object-path resolver, which can only walk JSON *objects* and silently matched nothing. The resolver now compiles array paths at any depth via an injected `resolveArrayPath`, so the common client shape — a base/scope filter `AND`ed with an array-path predicate — filters correctly instead of returning zero rows.
