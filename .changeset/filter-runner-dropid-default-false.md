---
"@dudousxd/nestjs-filter": minor
---

fix(core): `FilterRunner` (`@ApplyFilter`) now defaults `dropId` to `false`, matching the documented contract and the input normalizer.

**Behavior change.** Previously the `FilterRunner` code path treated an unset
`dropId` as `true` (`this.options.dropId ?? true`), so it silently stripped the
`Id` / `_id` suffix (and bare `id`) from incoming filter field keys by default —
even though every README/doc and `normalizeInput` itself document the default as
`false`. The two code paths now agree: with `dropId` unset, key suffixes are
**kept** (no stripping). Set `dropId: true` explicitly to opt back into stripping.

**Who is affected:** anyone using `FilterRunner` / `@ApplyFilter` who relied on
the implicit `Id`-stripping (e.g. sending `companyId` and expecting it to match a
`company` filter). Those keys will no longer be rewritten. To preserve the old
behavior, pass `dropId: true` in your `FilterModuleOptions`.
