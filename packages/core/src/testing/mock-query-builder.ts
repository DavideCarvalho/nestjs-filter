export type MockQueryBuilder<_E = unknown> = {
  readonly calls: Array<[string, ...unknown[]]>;
} & Record<string, (...args: unknown[]) => MockQueryBuilder<_E>>;

export function makeMockQueryBuilder<E = unknown>(): MockQueryBuilder<E> {
  const calls: Array<[string, ...unknown[]]> = [];
  const proxy = new Proxy({} as MockQueryBuilder<E>, {
    get(_t, prop) {
      if (prop === 'calls') return calls;
      const name = String(prop);
      return (...args: unknown[]) => {
        calls.push([name, ...args]);
        return proxy;
      };
    },
  });
  return proxy;
}
