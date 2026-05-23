import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { SqliteDriver } from '@mikro-orm/sqlite';
import { ReflectMetadataProvider } from '@mikro-orm/decorators/legacy';
import { FilterModule } from '@dudousxd/nestjs-filter';
import { MikroOrmFilterModule } from '@dudousxd/nestjs-filter-mikro-orm';
import { User } from './user.entity.js';
import { UserFilter } from './user.filter.js';
import { UsersController } from './users.controller.js';

@Module({
  imports: [
    MikroOrmModule.forRoot({
      driver: SqliteDriver,
      dbName: ':memory:',
      entities: [User],
      metadataProvider: ReflectMetadataProvider,
      allowGlobalContext: true,
    }),
    FilterModule.forRoot({ inputNormalizer: 'camelCase' }),
    MikroOrmFilterModule.forRoot(),
    FilterModule.forFeature([UserFilter]),
  ],
  controllers: [UsersController],
})
export class AppModule {}
