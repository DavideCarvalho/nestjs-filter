import 'reflect-metadata';
import type { Type } from '@nestjs/common';
import { FILTER_RELATIONS_METADATA } from '../tokens.js';

export interface RelationConfig {
  filter: Type<unknown>;
  keys: readonly string[];
}

export type RelationsMap = Record<string, RelationConfig>;

/**
 * Maps input keys to relation filters.
 * When an input key listed in a relation's `keys` array arrives,
 * the runner delegates it to the relation's filter via
 * adapter.applyRelationConstraint().
 *
 * @example
 * ```ts
 * @Relations({
 *   posts: { filter: PostFilter, keys: ['postTitle', 'postStatus'] },
 * })
 * export class UserFilter extends MikroOrmFilter<User> {}
 * ```
 */
export function Relations(map: RelationsMap): ClassDecorator {
  return (target) => {
    Reflect.defineMetadata(FILTER_RELATIONS_METADATA, map, target);
  };
}

export function getRelationsMap(target: object): RelationsMap | undefined {
  return Reflect.getMetadata(FILTER_RELATIONS_METADATA, target) as RelationsMap | undefined;
}

/**
 * Resolves which relation (if any) owns a given input key.
 * Returns [relationName, RelationConfig] or undefined.
 */
export function resolveRelation(
  target: object,
  inputKey: string,
): [string, RelationConfig] | undefined {
  const map = getRelationsMap(target);
  if (!map) return undefined;
  for (const [relationName, config] of Object.entries(map)) {
    if (config.keys.includes(inputKey)) {
      return [relationName, config];
    }
  }
  return undefined;
}
