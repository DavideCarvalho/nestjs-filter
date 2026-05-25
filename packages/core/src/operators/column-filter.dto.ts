import { Type } from 'class-transformer';
import { IsArray, IsIn, IsOptional, IsString, ValidateNested } from 'class-validator';
import { FILTER_OPERATORS } from './types.js';

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
  @IsIn(FILTER_OPERATORS as unknown as string[])
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
