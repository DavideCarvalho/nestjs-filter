import { FilterModule } from '@dudousxd/nestjs-filter';
import { MikroOrmFilterModule } from '@dudousxd/nestjs-filter-mikro-orm';
import { ReflectMetadataProvider } from '@mikro-orm/decorators/legacy';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { PostgreSqlDriver } from '@mikro-orm/postgresql';
import { Module } from '@nestjs/common';
import { Post } from './post.entity.js';
import { PostFilter } from './post.filter.js';
import { User } from './user.entity.js';
import { UserFilter } from './user.filter.js';
import { UsersController } from './users.controller.js';

@Module({
  imports: [
    MikroOrmModule.forRoot({
      driver: PostgreSqlDriver,
      host: process.env.DB_HOST ?? 'localhost',
      port: Number(process.env.DB_PORT ?? '5432'),
      user: process.env.DB_USER ?? 'test',
      password: process.env.DB_PASSWORD ?? 'test',
      dbName: process.env.DB_NAME ?? 'nestjs_filter_mikro',
      entities: [User, Post],
      metadataProvider: ReflectMetadataProvider,
      allowGlobalContext: true,
    }),
    FilterModule.forRoot({ inputNormalizer: 'camelCase' }),
    MikroOrmFilterModule.forRoot(),
    FilterModule.forFeature([UserFilter, PostFilter]),
  ],
  controllers: [UsersController],
})
export class AppModule {}
