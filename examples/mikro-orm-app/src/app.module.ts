import { FilterModule } from '@dudousxd/nestjs-filter';
import { MikroOrmFilterModule } from '@dudousxd/nestjs-filter-mikro-orm';
import { ReflectMetadataProvider } from '@mikro-orm/decorators/legacy';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { SqliteDriver } from '@mikro-orm/sqlite';
import { Module } from '@nestjs/common';
import { Post } from './post.entity.js';
import { User } from './user.entity.js';
import { UserFilter } from './user.filter.js';
import { UsersController } from './users.controller.js';

@Module({
  imports: [
    MikroOrmModule.forRoot({
      driver: SqliteDriver,
      dbName: ':memory:',
      entities: [User, Post],
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
