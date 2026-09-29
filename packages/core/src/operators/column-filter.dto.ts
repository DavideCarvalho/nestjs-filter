import { createRequire } from 'node:module';
import { FILTER_OPERATORS, OPERATOR_ALIASES } from './types.js';

/** Canonical operators plus SQL-symbol aliases accepted on input. */
const ACCEPTED_OPERATORS: readonly string[] = [
  ...FILTER_OPERATORS,
  ...Object.keys(OPERATOR_ALIASES),
];

type PropertyDecoratorFn = (target: object, propertyKey: string) => void;
type DecoratorFactory = (...args: unknown[]) => PropertyDecoratorFn;

interface ClassValidatorLike {
  IsArray: DecoratorFactory;
  IsIn: DecoratorFactory;
  IsOptional: DecoratorFactory;
  IsString: DecoratorFactory;
  ValidateNested: DecoratorFactory;
}

interface ClassTransformerLike {
  Type: DecoratorFactory;
}

/**
 * `class-validator` / `class-transformer` are OPTIONAL peers. They are only
 * needed by consumers that validate request bodies with `ColumnFilterDto`
 * (e.g. through Nest's `ValidationPipe`), so they must never be imported at
 * module load — otherwise merely importing `@dudousxd/nestjs-filter` (or an
 * adapter) crashes in apps that don't install them.
 *
 * Both packages ship CommonJS entry points, so a synchronous `require` resolved
 * from this module's location gives the same instance a static import would
 * (and the same one Nest's `ValidationPipe` loads).
 */
function tryRequire<T>(name: string): T | null {
  try {
    return createRequire(import.meta.url)(name) as T;
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    if (code === 'MODULE_NOT_FOUND' || code === 'ERR_MODULE_NOT_FOUND') return null;
    throw err;
  }
}

const cv = tryRequire<ClassValidatorLike>('class-validator');
const ct = tryRequire<ClassTransformerLike>('class-transformer');

const MISSING_PEERS = [!cv && 'class-validator', !ct && 'class-transformer'].filter(
  (name): name is string => typeof name === 'string',
);

/**
 * Reusable DTO for ColumnFilter with class-validator decorators.
 *
 * Requires the optional peers `class-validator` and `class-transformer`.
 * Importing the class without them is fine; instantiating it (which is what
 * `plainToInstance` / `ValidationPipe` do) throws an error naming the missing
 * package(s).
 *
 * Usage in a NestJS controller body DTO:
 * ```ts
 * class SearchDto {
 *   @IsOptional()
 *   @IsArray()
 *   @ValidateNested({ each: true })
 *   @Type(() => ColumnFilterDto)
 *   where?: ColumnFilterDto[];
 * }
 * ```
 */
export class ColumnFilterDto {
  field!: string;

  operator!: string;

  value?: unknown;

  AND?: ColumnFilterDto[];

  OR?: ColumnFilterDto[];

  constructor() {
    if (MISSING_PEERS.length > 0) {
      throw new Error(
        `ColumnFilterDto requires the optional peer dependencies "class-validator" and "class-transformer" (missing: ${MISSING_PEERS.join(', ')}). Install them to validate filter bodies with ColumnFilterDto.`,
      );
    }
  }
}

function decorate(
  key: keyof ColumnFilterDto,
  designType: unknown,
  decorators: PropertyDecoratorFn[],
): void {
  const proto = ColumnFilterDto.prototype;
  // Mirror what `emitDecoratorMetadata` would have emitted for the property.
  const reflect = Reflect as unknown as {
    defineMetadata?: (k: string, v: unknown, t: object, p: string) => void;
  };
  reflect.defineMetadata?.('design:type', designType, proto, key);
  // TypeScript applies property decorators bottom-up; keep that order.
  for (const d of [...decorators].reverse()) d(proto, key);
}

if (cv && ct) {
  const nested = (): PropertyDecoratorFn[] => [
    cv.IsOptional(),
    cv.IsArray(),
    cv.ValidateNested({ each: true }),
    ct.Type(() => ColumnFilterDto),
  ];
  decorate('field', String, [cv.IsString()]);
  decorate('operator', String, [cv.IsString(), cv.IsIn(ACCEPTED_OPERATORS)]);
  decorate('value', Object, [cv.IsOptional()]);
  decorate('AND', Array, nested());
  decorate('OR', Array, nested());
}
