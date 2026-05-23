export interface MockQueryBuilder<_E = unknown> {
  calls: Array<[string, ...unknown[]]>;
  [method: string]: (...args: unknown[]) => MockQueryBuilder<_E>;
}

export function makeMockQueryBuilder<E = unknown>(): MockQueryBuilder<E> & { calls: Array<[string, ...unknown[]]> } {
  const target = { calls: [] as Array<[string, ...unknown[]]> };
  const proxy: MockQueryBuilder<E> = new Proxy(target as unknown as MockQueryBuilder<E>, {
    get(t, prop) {
      if (prop === 'calls') return (t as unknown as { calls: unknown[] }).calls;
      const name = String(prop);
      return (...args: unknown[]) => {
        (t as unknown as { calls: Array<[string, ...unknown[]]> }).calls.push([name, ...args]);
        return proxy;
      };
    },
  });
  return proxy as MockQueryBuilder<E> & { calls: Array<[string, ...unknown[]]> };
}
