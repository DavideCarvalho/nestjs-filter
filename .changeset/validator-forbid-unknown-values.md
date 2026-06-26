---
"@dudousxd/nestjs-filter": patch
---

Fix `validation: 'auto'` rejecting filters that have no class-validator decorators. class-validator >= 0.14 defaults `forbidUnknownValues` to `true`, so `validateInput` flagged any decorator-less filter instance with a spurious "an unknown value was passed to the validate function" error (a 500 on every search). `validateInput` now passes `forbidUnknownValues: false`, so decorator-less filters validate cleanly while real constraints are still enforced when decorators are present.
