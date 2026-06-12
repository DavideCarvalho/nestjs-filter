import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import type { EntityFieldInfo, EntityRelationInfo, FilterAdapter } from '../src/adapter/adapter.js';
import { FilterRunner } from '../src/runner.js';
import { FILTER_ADAPTER, FILTER_MODULE_OPTIONS } from '../src/tokens.js';

class FakeEntity {}

const rootFields: EntityFieldInfo[] = [
  { name: 'id', columnName: 'id', type: 'number' },
  { name: 'name', columnName: 'name', type: 'string' },
  { name: 'createdAt', columnName: 'created_at', type: 'date' },
];

const rootRelations: EntityRelationInfo[] = [
  { name: 'base', targetEntity: 'Base', type: 'many-to-one' },
  { name: 'posts', targetEntity: 'Post', type: 'one-to-many' },
];

const baseFields: EntityFieldInfo[] = [
  { name: 'id', columnName: 'id', type: 'number' },
  { name: 'label', columnName: 'label', type: 'string' },
];

function makeAdapter(counters: { entityFields: number; related: number }): FilterAdapter {
  return {
    createQueryBuilder: () => ({}),
    getEntityFields: () => {
      counters.entityFields++;
      return rootFields;
    },
    getEntityRelations: () => rootRelations,
    getRelatedFields: (_entity, relationName) => {
      counters.related++;
      return relationName === 'base' ? baseFields : [];
    },
  };
}

async function makeRunner(adapter: FilterAdapter | null) {
  const mod = await Test.createTestingModule({
    providers: [
      FilterRunner,
      { provide: FILTER_MODULE_OPTIONS, useValue: { validation: 'off' } },
      { provide: FILTER_ADAPTER, useValue: adapter },
    ],
  }).compile();
  return mod.get(FilterRunner);
}

describe('FilterRunner.describe', () => {
  it('returns root scalar fields from entity metadata', async () => {
    const counters = { entityFields: 0, related: 0 };
    const runner = await makeRunner(makeAdapter(counters));
    const desc = runner.describe(FakeEntity);
    expect(desc.fields).toEqual({
      id: { type: 'number', column: 'id' },
      name: { type: 'string', column: 'name' },
      createdAt: { type: 'date', column: 'created_at' },
    });
  });

  it('expands one hop of relations with their own scalar fields', async () => {
    const counters = { entityFields: 0, related: 0 };
    const runner = await makeRunner(makeAdapter(counters));
    const desc = runner.describe(FakeEntity);
    expect(desc.relations.base).toEqual({
      kind: 'many-to-one',
      target: 'Base',
      fields: {
        id: { type: 'number', column: 'id' },
        label: { type: 'string', column: 'label' },
      },
    });
    // posts has no related fields resolved → empty fields, still listed
    expect(desc.relations.posts).toEqual({
      kind: 'one-to-many',
      target: 'Post',
      fields: {},
    });
  });

  it('memoizes per entity — adapter metadata is read once', async () => {
    const counters = { entityFields: 0, related: 0 };
    const runner = await makeRunner(makeAdapter(counters));
    const first = runner.describe(FakeEntity);
    const second = runner.describe(FakeEntity);
    expect(second).toBe(first); // same reference
    expect(counters.entityFields).toBe(1); // not re-read
  });

  it('degrades gracefully when the adapter lacks getRelatedFields', async () => {
    const adapter: FilterAdapter = {
      createQueryBuilder: () => ({}),
      getEntityFields: () => rootFields,
      getEntityRelations: () => rootRelations,
    };
    const runner = await makeRunner(adapter);
    const desc = runner.describe(FakeEntity);
    expect(desc.relations.base.fields).toEqual({});
    expect(desc.fields.name).toEqual({ type: 'string', column: 'name' });
  });

  it('returns empty description when no adapter metadata is available', async () => {
    const adapter: FilterAdapter = { createQueryBuilder: () => ({}) };
    const runner = await makeRunner(adapter);
    const desc = runner.describe(FakeEntity);
    expect(desc).toEqual({ fields: {}, relations: {} });
  });
});
