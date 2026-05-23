import { BaseFilter } from '@dudousxd/nestjs-filter';
import type { QueryBuilder } from '@mikro-orm/knex';

export abstract class MikroOrmFilter<E extends object> extends BaseFilter<QueryBuilder<E>> {}
