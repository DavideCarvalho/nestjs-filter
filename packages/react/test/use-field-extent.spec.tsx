import { type FilterQueryResult, filterQuery } from '@dudousxd/nestjs-filter-client';
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  type FieldExtent,
  type FieldExtentFetcher,
  useFieldExtent,
} from '../src/use-field-extent.js';
import { useFilterQuery } from '../src/use-filter-query.js';

type Answer = Record<string, FieldExtent<number>>;

/** A promise whose settlement the test drives, to hold a request in flight. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const filtered = () => filterQuery().where('baseId', 'equals', 'b1');

describe('useFieldExtent', () => {
  it('asks for every field in ONE request, carrying only the row-selecting body', async () => {
    const fetcher = vi.fn<FieldExtentFetcher<number>>(async () => ({
      cost: { min: 10, max: 90 },
      completedAt: { min: 1, max: 2 },
    }));
    const body = filtered().include('base').sort('cost', 'asc').page(2, 20).build();

    const { result } = renderHook(() => useFieldExtent(body, ['cost', 'completedAt'], fetcher));

    await waitFor(() => expect(result.current.status).toBe('success'));
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith(
      {
        filter: { where: [{ field: 'baseId', operator: 'equals', value: 'b1' }] },
        extent: ['cost', 'completedAt'],
      },
      expect.any(AbortSignal),
    );
  });

  it('carries a caller top-level key through, since it may narrow the row set', async () => {
    const fetcher = vi.fn<FieldExtentFetcher<number>>(async () => ({}));
    const body = filtered().set('tenantId', 't1').build();

    renderHook(() => useFieldExtent(body, ['cost'], fetcher));

    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    expect(fetcher).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 't1', extent: ['cost'] }),
      expect.any(AbortSignal),
    );
  });

  it('reports loading before the answer, then the measured endpoints', async () => {
    const pending = deferred<Answer>();
    const body = filtered().build();

    const { result } = renderHook(() => useFieldExtent(body, ['cost'], () => pending.promise));

    expect(result.current.status).toBe('loading');
    expect(result.current.isFetching).toBe(true);
    expect(result.current.of('cost')).toEqual({ status: 'loading' });

    await act(async () => {
      pending.resolve({ cost: { min: 10, max: 90 } });
    });

    expect(result.current.of('cost')).toEqual({ status: 'measured', min: 10, max: 90 });
    expect(result.current.isFetching).toBe(false);
    expect(result.current.data).toEqual({ cost: { min: 10, max: 90 } });
  });

  it('tells "no values in scope" apart from "not measurable"', async () => {
    const fetcher: FieldExtentFetcher<number> = async () => ({
      cost: { min: null, max: null },
      // `hours` is absent — the server could not measure it at all.
    });
    const body = filtered().build();

    const { result } = renderHook(() => useFieldExtent(body, ['cost', 'hours'], fetcher));

    await waitFor(() => expect(result.current.status).toBe('success'));
    expect(result.current.of('cost')).toEqual({ status: 'empty' });
    expect(result.current.of('hours')).toEqual({ status: 'unmeasured' });
  });

  it('reads a zero-based range as measured, not as empty', async () => {
    const fetcher: FieldExtentFetcher<number> = async () => ({ cost: { min: 0, max: 0 } });
    const { result } = renderHook(() => useFieldExtent(filtered().build(), ['cost'], fetcher));

    await waitFor(() => expect(result.current.status).toBe('success'));
    expect(result.current.of('cost')).toEqual({ status: 'measured', min: 0, max: 0 });
  });

  it('surfaces a failed request as an error on every requested field', async () => {
    const pending = deferred<Answer>();
    const boom = new Error('500');

    const { result } = renderHook(() =>
      useFieldExtent(filtered().build(), ['cost', 'hours'], () => pending.promise),
    );

    await act(async () => {
      pending.reject(boom);
    });

    expect(result.current.status).toBe('error');
    expect(result.current.error).toBe(boom);
    expect(result.current.of('cost')).toEqual({ status: 'error', error: boom });
    expect(result.current.of('hours')).toEqual({ status: 'error', error: boom });
    expect(result.current.isFetching).toBe(false);
  });

  it('re-measures when the filter changes, dropping the stale extent at once', async () => {
    const answers: Answer[] = [{ cost: { min: 10, max: 90 } }, { cost: { min: 40, max: 50 } }];
    const fetcher = vi.fn<FieldExtentFetcher<number>>(async () => answers.shift() ?? {});

    const { result } = renderHook(() => {
      const [qb, body] = useFilterQuery(filterQuery);
      return { qb, extent: useFieldExtent(body, ['cost'], fetcher) };
    });

    await waitFor(() => expect(result.current.extent.status).toBe('success'));
    expect(result.current.extent.of('cost')).toEqual({ status: 'measured', min: 10, max: 90 });

    act(() => {
      result.current.qb.where('baseId', 'equals', 'b2');
    });

    // Not "old but usable": it describes rows the filter no longer selects.
    expect(result.current.extent.of('cost')).toEqual({ status: 'loading' });
    expect(result.current.extent.data).toBeUndefined();

    // Wait on the state, not on the call count: "the fetcher was called" is not
    // "the promise resolved and React re-rendered". Waiting on the proxy passes
    // on a fast machine and reads `loading` on a slower one, which is how this
    // first failed — green locally, red in CI.
    await waitFor(() =>
      expect(result.current.extent.of('cost')).toEqual({
        status: 'measured',
        min: 40,
        max: 50,
      }),
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('does not re-measure when only the page or the sort changes', async () => {
    const fetcher = vi.fn<FieldExtentFetcher<number>>(async () => ({ cost: { min: 10, max: 90 } }));

    const { result } = renderHook(() => {
      const [qb, body] = useFilterQuery(filterQuery);
      return { qb, extent: useFieldExtent(body, ['cost'], fetcher) };
    });

    await waitFor(() => expect(result.current.extent.status).toBe('success'));

    await act(async () => {
      result.current.qb.page(3, 20).sort('cost', 'desc').include('base');
    });

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(result.current.extent.of('cost')).toEqual({ status: 'measured', min: 10, max: 90 });
  });

  it('ignores a response the filter has already moved on from', async () => {
    const first = deferred<Answer>();
    const second = deferred<Answer>();
    const pendings = [first, second];
    const fetcher = vi.fn<FieldExtentFetcher<number>>(() => {
      const next = pendings.shift();
      return next ? next.promise : Promise.resolve({});
    });

    const { result } = renderHook(() => {
      const [qb, body] = useFilterQuery(filterQuery);
      return { qb, extent: useFieldExtent(body, ['cost'], fetcher) };
    });

    act(() => {
      result.current.qb.where('baseId', 'equals', 'b2');
    });
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));

    await act(async () => {
      second.resolve({ cost: { min: 40, max: 50 } });
    });
    // The superseded request lands late; it must not overwrite the newer answer.
    await act(async () => {
      first.resolve({ cost: { min: 10, max: 90 } });
    });

    expect(result.current.extent.of('cost')).toEqual({ status: 'measured', min: 40, max: 50 });
  });

  it('asks nothing at all for an empty field list', async () => {
    const fetcher = vi.fn<FieldExtentFetcher<number>>(async () => ({}));
    const fields: string[] = [];

    const { result } = renderHook(() => useFieldExtent(filtered().build(), fields, fetcher));

    await waitFor(() => expect(result.current.status).toBe('success'));
    expect(fetcher).not.toHaveBeenCalled();
    expect(result.current.isFetching).toBe(false);
    expect(result.current.of('cost')).toEqual({ status: 'unmeasured' });
  });

  it('refetch re-asks and keeps the previous answer readable while it runs', async () => {
    const answers: Answer[] = [{ cost: { min: 10, max: 90 } }];
    const pending = deferred<Answer>();
    const fetcher = vi.fn<FieldExtentFetcher<number>>(() => {
      const next = answers.shift();
      return next ? Promise.resolve(next) : pending.promise;
    });
    const body = filtered().build();

    const { result } = renderHook(() => useFieldExtent(body, ['cost'], fetcher));
    await waitFor(() => expect(result.current.status).toBe('success'));

    act(() => {
      result.current.refetch();
    });

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(result.current.isFetching).toBe(true);
    expect(result.current.of('cost')).toEqual({ status: 'measured', min: 10, max: 90 });

    await act(async () => {
      pending.resolve({ cost: { min: 40, max: 50 } });
    });
    expect(result.current.of('cost')).toEqual({ status: 'measured', min: 40, max: 50 });
  });

  it('re-measures when the requested field list changes', async () => {
    const fetcher = vi.fn<FieldExtentFetcher<number>>(async () => ({ cost: { min: 1, max: 2 } }));
    const body: FilterQueryResult = filtered().build();

    const { result, rerender } = renderHook(
      ({ fields }: { fields: string[] }) => useFieldExtent(body, fields, fetcher),
      { initialProps: { fields: ['cost'] } },
    );

    await waitFor(() => expect(result.current.status).toBe('success'));

    rerender({ fields: ['cost', 'hours'] });
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    expect(fetcher).toHaveBeenLastCalledWith(
      expect.objectContaining({ extent: ['cost', 'hours'] }),
      expect.any(AbortSignal),
    );
  });
});
