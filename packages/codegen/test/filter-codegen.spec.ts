import { describe, expect, it } from 'vitest';
import { nestjsFilterCodegen } from '../src/index.js';

// Minimal LeafModel/ExtensionContext stand-ins — the extension only reads
// `leaf.route.contract.contractSource.{filterFields,filterFieldTypes}` and `ctx.routes`.
function leaf(contractSource: unknown) {
  return { route: { contract: { contractSource } } } as never;
}
function ctx(routes: unknown[]) {
  return { routes } as never;
}

describe('nestjsFilterCodegen', () => {
  it('is a named extension with apiHeader + apiMembers', () => {
    const ext = nestjsFilterCodegen();
    expect(ext.name).toBe('nestjs-filter');
    expect(typeof ext.apiHeader).toBe('function');
    expect(typeof ext.apiMembers).toBe('function');
  });

  it('apiMembers adds filterQuery for a filtered route (fields union)', () => {
    const ext = nestjsFilterCodegen();
    const members = ext.apiMembers?.(leaf({ filterFields: ['status', 'name'] }), ctx([]));
    expect(members?.filterQuery).toBe('() => _filterQueryTyped<"status" | "name">()');
  });

  it('apiMembers emits runtime filter metadata (fields + types)', () => {
    const ext = nestjsFilterCodegen();
    const members = ext.apiMembers?.(
      leaf({
        filterFields: ['name', 'age'],
        filterFieldTypes: [
          { name: 'name', kind: 'string' },
          { name: 'age', kind: 'number' },
        ],
      }),
      ctx([]),
    );
    expect(members?.filter).toBe(
      '{ fields: ["name", "age"], types: { "name": "string", "age": "number" } }',
    );
  });

  it('filter metadata has an empty types map when no field types are classified', () => {
    const ext = nestjsFilterCodegen();
    const members = ext.apiMembers?.(leaf({ filterFields: ['status', 'name'] }), ctx([]));
    expect(members?.filter).toBe('{ fields: ["status", "name"], types: {} }');
  });

  it('apiMembers includes the field-type map when present (typeRef + nullable + enum)', () => {
    const ext = nestjsFilterCodegen();
    const members = ext.apiMembers?.(
      leaf({
        filterFields: ['age', 'status', 'role'],
        filterFieldTypes: [
          { name: 'age', kind: 'number', nullable: true },
          { name: 'status', kind: 'string', enumValues: ['A', 'B'] },
          { name: 'role', kind: 'string', typeRef: { name: 'Role' } },
        ],
      }),
      ctx([]),
    );
    expect(members?.filterQuery).toBe(
      '() => _filterQueryTyped<"age" | "status" | "role", { "age": number | null; "status": "A" | "B"; "role": Role }>()',
    );
  });

  it('apiMembers returns undefined for a non-filtered route', () => {
    const ext = nestjsFilterCodegen();
    expect(ext.apiMembers?.(leaf({ filterFields: [] }), ctx([]))).toBeUndefined();
    expect(ext.apiMembers?.(leaf({}), ctx([]))).toBeUndefined();
  });

  it('apiHeader imports filter-client only when some route is filtered', () => {
    const ext = nestjsFilterCodegen();
    expect(
      ext.apiHeader?.(ctx([{ contract: { contractSource: { filterFields: ['x'] } } }])),
    ).toEqual({
      imports: [
        "import { filterQueryTyped as _filterQueryTyped } from '@dudousxd/nestjs-filter-client';",
      ],
    });
    expect(ext.apiHeader?.(ctx([{ contract: { contractSource: {} } }]))).toBeUndefined();
  });
});
