import { Type } from 'class-transformer';
import { IsArray, IsIn, IsOptional, IsString, ValidateNested } from 'class-validator';
import { FILTER_OPERATORS, OPERATOR_ALIASES } from './types.js';

/** Canonical operators plus SQL-symbol aliases accepted on input. */
const ACCEPTED_OPERATORS: readonly string[] = [
  ...FILTER_OPERATORS,
  ...Object.keys(OPERATOR_ALIASES),
];

/**
 * Reusable DTO for ColumnFilter with class-validator decorators.
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
  @IsString()
  field!: string;

  @IsString()
  @IsIn(ACCEPTED_OPERATORS)
  operator!: string;

  @IsOptional()
  value?: unknown;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ColumnFilterDto)
  AND?: ColumnFilterDto[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ColumnFilterDto)
  OR?: ColumnFilterDto[];
}
