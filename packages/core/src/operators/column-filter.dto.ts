import { Type } from 'class-transformer';
import { IsArray, IsOptional, IsString, ValidateNested } from 'class-validator';

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
