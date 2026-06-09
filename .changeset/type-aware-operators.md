---
"@dudousxd/nestjs-filter-client": minor
"@dudousxd/nestjs-filter": minor
---

Type-aware filter operators. The typed client builder (`filterQueryTyped<Fields, Map>`)
now narrows operators and value types per field: string fields accept only string
operators, number/Date accept ordering + tuple, enums narrow to their literals, and
the unary convenience methods (`isEmpty`/`isNotEmpty`) are gated to fields whose type
allows them. Backward compatible — the single-generic builder stays fully permissive.

Adds an optional `@FilterFor('key', { type })` hint (stored in separate metadata, no
runtime effect) so virtual filter fields with no matching entity column can still get
precise types in the generated client. Also hardens the type-vs-runtime operator
drift guard to assert per-group from a single source of truth.
