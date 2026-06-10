import { filterQuery } from '@dudousxd/nestjs-filter-client';
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useFilterQuery } from '../src/use-filter-query.js';

describe('useFilterQuery', () => {
  it('keeps the builder instance stable across renders', () => {
    const { result, rerender } = renderHook(() => useFilterQuery(filterQuery));
    const [builderA] = result.current;
    rerender();
    const [builderB] = result.current;
    expect(builderB).toBe(builderA);
  });

  it('runs init exactly once, before first render', () => {
    const init = vi.fn((qb: ReturnType<typeof filterQuery>) => {
      qb.sort('email', 'asc');
    });
    const { result, rerender } = renderHook(() => useFilterQuery(filterQuery, init));

    expect(init).toHaveBeenCalledTimes(1);
    expect(result.current[1]).toEqual({
      filter: { where: [] },
      sort: [{ field: 'email', direction: 'asc' }],
    });

    rerender();
    expect(init).toHaveBeenCalledTimes(1);
  });

  it('re-renders with a fresh body when the builder mutates', () => {
    const { result } = renderHook(() => useFilterQuery(filterQuery));
    const [qb, initialBody] = result.current;

    expect(initialBody).toEqual({ filter: { where: [] } });

    act(() => {
      qb.where('name', 'iContains', 'davi');
    });

    const [, nextBody] = result.current;
    expect(nextBody).not.toBe(initialBody);
    expect(nextBody).toEqual({
      filter: { where: [{ field: 'name', operator: 'iContains', value: 'davi' }] },
    });
  });

  it('keeps the body reference stable across renders with no mutation', () => {
    const { result, rerender } = renderHook(() => useFilterQuery(filterQuery));
    const [, bodyA] = result.current;
    rerender();
    const [, bodyB] = result.current;
    expect(bodyB).toBe(bodyA);
  });

  it('reflects multiple sequential mutations', () => {
    const { result } = renderHook(() => useFilterQuery(filterQuery));
    const [qb] = result.current;

    act(() => {
      qb.where('role.name', 'equals', 'ADMIN');
    });
    act(() => {
      qb.page(2, 20);
    });

    expect(result.current[1]).toEqual({
      filter: { where: [{ field: 'role.name', operator: 'equals', value: 'ADMIN' }] },
      paginate: { page: 2, size: 20 },
    });
  });
});
