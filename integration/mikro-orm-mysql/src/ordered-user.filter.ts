import { Filterable } from '@dudousxd/nestjs-filter';
import { MikroOrmFilter } from '@dudousxd/nestjs-filter-mikro-orm';
import { Injectable } from '@nestjs/common';
import { User } from './user.entity.js';

/**
 * `UserFilter`'s twin with `distinctOrder` on, so the ordering the option adds
 * is exercised against a real MySQL rather than a mock query builder.
 *
 * A real engine is the only thing that can prove this: MySQL rejects an
 * `ORDER BY` term that is not in a `SELECT DISTINCT`'s select list outright
 * (error 3065 — a failed query, not a warning), and the projection spells the
 * three member kinds three different ways. A plain column is its own name; a
 * relation path and a JSON sub-path are projected under a dotted ALIAS; a
 * computed member is an expression under an alias. Get the ORDER BY spelling
 * wrong for any of them and the request 500s — which no mocked adapter and no
 * SQLite run would ever show, since SQLite does not enforce the rule at all.
 *
 * The computed member is the one worth the extra file: its ORDER BY comes from
 * the computed-aware sort path (`applyComputedSort`) while its projection comes
 * from `applyComputedDistinct`, and the two have to agree textually.
 */
@Injectable()
@Filterable({
  entity: User,
  distinctOrder: true,
  computed: { nameLength: 'CHAR_LENGTH(name)' },
})
export class OrderedUserFilter extends MikroOrmFilter<User> {}
