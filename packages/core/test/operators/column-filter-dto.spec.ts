import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';
import { ColumnFilterDto } from '../../src/operators/column-filter.dto.js';

async function errorsFor(plain: unknown) {
  const instance = plainToInstance(ColumnFilterDto, plain);
  return validate(instance as object);
}

describe('ColumnFilterDto (class-validator installed)', () => {
  it('accepts a valid filter, including SQL-symbol operator aliases', async () => {
    expect(await errorsFor({ field: 'name', operator: 'equals', value: 'x' })).toHaveLength(0);
    expect(await errorsFor({ field: 'age', operator: '>=', value: 3 })).toHaveLength(0);
  });

  it('rejects unknown operators and non-string fields', async () => {
    const errors = await errorsFor({ field: 1, operator: 'nope' });
    expect(errors.map((e) => e.property).sort()).toEqual(['field', 'operator']);
  });

  it('validates nested AND/OR groups as ColumnFilterDto instances', async () => {
    const instance = plainToInstance(ColumnFilterDto, {
      field: 'a',
      operator: 'equals',
      OR: [{ field: 'b', operator: 'bogus' }],
    });
    expect(instance.OR?.[0]).toBeInstanceOf(ColumnFilterDto);
    const errors = await validate(instance);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.property).toBe('OR');
  });
});
