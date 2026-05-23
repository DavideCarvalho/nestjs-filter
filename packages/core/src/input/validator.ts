import type { Type } from '@nestjs/common';
import { FilterValidationException } from '../errors/exceptions.js';

let cached: { validate: Function; plainToInstance: Function } | null | undefined;

async function loadValidator(): Promise<{ validate: Function; plainToInstance: Function } | null> {
  if (cached !== undefined) return cached;
  try {
    const cv = (await import('class-validator')) as unknown as { validate: Function };
    const ct = (await import('class-transformer')) as unknown as { plainToInstance: Function };
    cached = { validate: cv.validate, plainToInstance: ct.plainToInstance };
  } catch {
    cached = null;
  }
  return cached;
}

export async function validateInput<F>(
  FilterClass: Type<F>,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const mod = await loadValidator();
  if (!mod) return input;
  const instance = mod.plainToInstance(FilterClass, input);
  const errors = (await mod.validate(instance, {
    whitelist: false,
    forbidNonWhitelisted: false,
  })) as unknown[];
  if (errors.length > 0) throw new FilterValidationException(errors);
  return instance as Record<string, unknown>;
}
