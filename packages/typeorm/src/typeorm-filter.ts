import { BaseFilter } from '@dudousxd/nestjs-filter';
import type { ObjectLiteral, SelectQueryBuilder } from 'typeorm';

export abstract class TypeOrmFilter<E extends ObjectLiteral> extends BaseFilter<SelectQueryBuilder<E>> {}
