---
'@dudousxd/nestjs-filter': minor
'@dudousxd/nestjs-filter-mikro-orm': minor
---

To-one relation paths now work in `distinct`.

`where` accepts `base.name`, `sort` accepts `base.name`, and the generated `filterFields` union offers it — so `.distinct('base.name')` typechecks. It was then dropped: `validateDistinct` resolved the field against the ROOT entity's scalar columns only, the projection never reached the query builder, and the request came back as a page of full entity rows instead of a column of values. A filter dropdown over a relation column ("which bases appear in these rows?") therefore could not be built on the route that exists to answer exactly that.

Silent for the caller, and worse where a total was involved: the adapter's `getDistinctResultAndCount` still received the dotted field and handed it to `getCount(fields, true)`, which emits it against an alias nothing joined — `Unknown column 'base.name' in 'field list'`. So the shape that looked most correct (asking for the values AND the count) is the one that 500'd.

This is another cell of the matrix the computed-alias and aggregate-path releases filled in — the union promising something the runtime doesn't honor — for the last kind of path `where`/`sort` already accepted.

`validateDistinct` now mirrors `validateSorts`: with an adapter that can resolve field paths, any path ending in a scalar column is accepted. A bare relation (`author`) stays rejected — there is no single column to project — and so does a JSON sub-path, which needs an extract expression the distinct path does not build. The `FilterClass.distinct` allowlist is unchanged and still wins by exact membership.

For MikroORM, `applyDistinct` joins each relation on the path (`leftJoin`, never `join` — an INNER join would drop rows with a null FK, turning a projection into a filter) and projects `<alias>.<column> as "base.name"`, reusing a join the WHERE or ORDER BY already established rather than adding a second one. The result row keeps the DOTTED key the caller asked for, because for a single-column projection the field name IS the contract. Only to-one hops are projected: a to-many join multiplies the rows, which is not what a column-values dropdown asked for.

A relation path in the projection also marks the builder for the `count(*)`-wrapper total that computed members already used — the plain `getCount(fields, true)` cannot count a dotted path either.

TypeORM is unaffected: its adapter implements no `resolveFieldPath`, so validation falls through to the scalar-column path exactly as before.
