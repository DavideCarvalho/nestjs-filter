---
'@dudousxd/nestjs-filter-client': minor
'@dudousxd/nestjs-filter-codegen': minor
---

Gate the typed builder's `.extent()` to fields the codegen classified as `number` or `date`, by emitting the field-kind map as a third type argument to `filterQueryTyped`.

An extent is `MIN`/`MAX`. Over a string, a boolean or a json column that is a well-formed query that answers nothing — a pair of ends no range control can place, or a key simply absent from the response because the adapter measured nothing. Nothing throws, nothing warns, and the slider renders empty. The whole point of `.extent()` is sizing a control, so the failure lands at the exact moment the caller has stopped looking.

```ts
// codegen now emits the kinds alongside the value types:
filterQuery: () => _filterQueryTyped<
  "cost" | "completedAt" | "name",
  { "cost": number; "completedAt": Date; "name": string },
  { "cost": "number"; "completedAt": "date"; "name": "string" }
>()

api.workOrders.search.filterQuery().extent('cost', 'completedAt'); // ok
api.workOrders.search.filterQuery().extent('name');                // compile error
```

The classification already existed and was being discarded. Codegen emits it as the runtime `filter.types` literal, which cannot help here: the host writes that inside a plain object literal, so its values widen to `string` and a `typeof` of it constrains nothing. Literal kinds only survive in a type position, so that is where they now also go.

**A third map rather than reading the second one.** The existing type map answers "what value does this field hold", and that question cannot be run backwards into a kind: a `typeRef` field arrives as an opaque name (`Role`), and `json` and `unknown` are indistinguishable once emitted. Deriving the gate from operator sets instead — "fields that accept `gt`" — lets both json and every unclassified field through, because those resolve to the permissive fallback. The kind is the classifier's own verdict, the same one the server used, so it is what the gate reads.

**Subtractive, not additive.** A field is refused only when the kind map positively says `string`, `boolean` or `json`. A field absent from the map, a field bucketed as `'unknown'`, and every field of a route with no classified types stay accepted. Silence in the map is codegen not knowing, not codegen ruling the field out, and promoting that to a compile error would break callers over what discovery failed to learn — the same reasoning that makes `OperatorsFor<unknown>` the full operator union.

**Compatibility runs one way, so the other way is now caught at install.** A `filterQueryTyped<Fields, Types>()` call site — hand-written, or generated before this release — leaves the kind map at its empty default, which excludes nothing: `.extent()` stays permissive over `Fields` and the build is untouched until the caller regenerates. The reverse pairing is the one that reads badly, since new codegen against an older client surfaces as `Expected 1-2 type arguments, but got 3` pointing into generated code nobody wrote, so `@dudousxd/nestjs-filter-codegen` now requires `@dudousxd/nestjs-filter-client >= 1.18.0` and the package manager says so first.

The untyped `filterQuery()` is unchanged and stays permissive. It has no route behind it and therefore no kinds to consult; narrowing it would only mean guessing.
