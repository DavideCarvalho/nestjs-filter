import type { FilterAdapter } from '@dudousxd/nestjs-filter';
import type { Type } from '@nestjs/common';
import type { DataSource, ObjectLiteral } from 'typeorm';

export class TypeOrmAdapter implements FilterAdapter {
  constructor(private readonly dataSource: DataSource) {}

  createQueryBuilder<E>(entity: Type<E>): unknown {
    const repo = this.dataSource.getRepository(entity as unknown as { new (): E & ObjectLiteral });
    const alias = (entity as unknown as { name: string }).name.toLowerCase();
    return repo.createQueryBuilder(alias);
  }
}
