import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DrizzleQuery } from '../src/drizzle-query.js';
import { DrizzleAdapter } from '../src/drizzle.adapter.js';
import { type TestDb, createTestDb, users } from './fixtures/sqlite-schema.js';

describe('DrizzleAdapter request-path queries', () => {
  let db: TestDb;
  let close: () => void;
  let adapter: DrizzleAdapter;

  beforeEach(() => {
    ({ db, close } = createTestDb());
    adapter = new DrizzleAdapter(db);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    close();
  });

  const q = () => adapter.createQueryBuilder(users) as DrizzleQuery<typeof users>;
  const countSpy = () => vi.spyOn(DrizzleQuery.prototype, 'count');

  it('a short page supplies the total without a count query', async () => {
    const count = countSpy();
    const query = q();
    adapter.applySort(query, [{ field: 'id', direction: 'asc' }]);
    adapter.applyOffsetPagination(query, 1, 3);

    const { rows, total } = await adapter.getResultAndCount(query);

    expect(rows).toHaveLength(1);
    expect(total).toBe(4);
    expect(count).not.toHaveBeenCalled();
  });

  it('a full page, or an empty one past an offset, still counts', async () => {
    const count = countSpy();
    const full = q();
    adapter.applyOffsetPagination(full, 0, 2);
    expect((await adapter.getResultAndCount(full)).total).toBe(4);

    const past = q();
    adapter.applyOffsetPagination(past, 5, 2);
    const { rows, total } = await adapter.getResultAndCount(past);
    expect(rows).toHaveLength(0);
    expect(total).toBe(4);
    expect(count).toHaveBeenCalledTimes(2);
  });

  it('a short distinct page supplies the total without a count query', async () => {
    const count = countSpy();
    const query = q();
    adapter.applyDistinct(query, ['role']);
    adapter.applyOffsetPagination(query, 0, 10);

    const { rows, total } = await adapter.getDistinctResultAndCount(query);

    expect(rows).toHaveLength(3);
    expect(total).toBe(3);
    expect(count).not.toHaveBeenCalled();
  });

  it('bounds the leading keyset column and returns the same rows', async () => {
    const keyset = [
      { field: 'age', direction: 'desc' as const },
      { field: 'id', direction: 'asc' as const },
    ];
    const query = q();
    adapter.applyKeysetPagination(query, keyset, [30, 2]);
    adapter.applyKeysetOrderAndLimit(query, keyset, 10);

    expect(query.toSQL().sql).toMatch(/where \("users"\."age" <= \? and \(/);
    const rows = await adapter.getResult(query);
    expect(rows.map((r) => (r as { name: string }).name)).toEqual(['Bob', 'Diana']);
  });
});
