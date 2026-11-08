---
"@dudousxd/nestjs-filter": minor
---

Translate client-facing error messages through NestJS's `@nestjs/i18n` when the app registers it (optional peer). `FilterExceptionFilter`'s `message` and the runner's `BadRequestException`s (invalid sort/distinct/extent/histogram/groupByCount field, operator not allowed, unknown filter column) are looked up as `filter.*` keys in the request's locale, checked with `exists()` first; without `@nestjs/i18n`, or for a key the catalogs lack, they stay in English. Ships `@dudousxd/nestjs-filter/i18n/en.json` and `pt-BR.json` for apps to merge into their catalogs, and exports `FILTER_MESSAGES`. `FilterExceptionFilter` takes an optional `I18nService` constructor argument (injected when registered as a class).
