import { type FilterQueryResult, filterQueryTyped } from '@dudousxd/nestjs-filter-client';
import { act, renderHook } from '@testing-library/react';
import { withNuqsTestingAdapter } from 'nuqs/adapters/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useFilterTable } from '../src/use-filter-table.js';

const route = {
  filterQuery: () => filterQueryTyped<'name' | 'email' | 'role.name'>(),
  queryOptions: (body: FilterQueryResult) => ({ queryKey: ['search', body] as const, body }),
};

const config = {
  include: ['role', 'bases'],
  sort: { email: 'asc' as const },
  pageSize: 20,
  search: { fields: ['name', 'email'] as ('name' | 'email')[], debounce: 300 },
  filters: { role: 'role.name' as const },
};

function setup(searchParams: string) {
  return renderHook(() => useFilterTable(route, config), {
    wrapper: withNuqsTestingAdapter({ searchParams, hasMemory: true }),
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe('useFilterTable', () => {
  it('applies static config (include, sort, page) on first render', () => {
    const { result } = setup('');
    expect(result.current.body).toEqual({
      filter: { where: [] },
      include: ['role', 'bases'],
      sort: [{ field: 'email', direction: 'asc' }],
      paginate: { page: 0, size: 20 },
    });
  });

  it('hydrates filters and page from the URL', () => {
    const { result } = setup('?role=ADMIN&page=2');
    expect(result.current.page).toBe(2);
    expect(result.current.filters.role).toBe('ADMIN');
    expect(result.current.body.filter.where).toEqual([
      { field: 'role.name', operator: 'equals', value: 'ADMIN' },
    ]);
    expect(result.current.body.paginate).toEqual({ page: 1, size: 20 });
  });

  it('setFilter updates the body and resets to page 1', () => {
    const { result } = setup('?page=3');
    act(() => {
      result.current.setFilter('role', 'EDITOR');
    });
    expect(result.current.page).toBe(1);
    expect(result.current.filters.role).toBe('EDITOR');
    expect(result.current.body.filter.where).toEqual([
      { field: 'role.name', operator: 'equals', value: 'EDITOR' },
    ]);
  });

  it('setPage updates pagination (0-based in the body)', () => {
    const { result } = setup('');
    act(() => {
      result.current.setPage(4);
    });
    expect(result.current.page).toBe(4);
    expect(result.current.body.paginate).toEqual({ page: 3, size: 20 });
  });

  it('setSearch updates the controlled value immediately, before debounce', () => {
    vi.useFakeTimers();
    const { result } = setup('');
    act(() => {
      result.current.setSearch('davi');
    });
    // immediate: the input reflects it, but the body has not yet rebuilt
    expect(result.current.search).toBe('davi');
    expect(result.current.body.filter.where).toEqual([]);
  });

  it('writes a debounced OR search group into the body after the delay', () => {
    vi.useFakeTimers();
    const { result } = setup('');
    act(() => {
      result.current.setSearch('davi');
    });
    act(() => {
      vi.advanceTimersByTime(300);
    });
    const where = result.current.body.filter.where;
    expect(where).toHaveLength(1);
    expect(where[0]).toMatchObject({
      OR: [
        { field: 'name', operator: 'iContains', value: 'davi' },
        { field: 'email', operator: 'iContains', value: 'davi' },
      ],
    });
  });

  it('exposes queryOptions wired to the route', () => {
    const { result } = setup('?role=ADMIN');
    const opts = result.current.queryOptions();
    expect(opts.body).toBe(result.current.body);
    expect(opts.queryKey[0]).toBe('search');
  });
});
