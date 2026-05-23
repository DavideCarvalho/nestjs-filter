import { FilterModule } from '@dudousxd/nestjs-filter';
import { TypeOrmFilterModule } from '@dudousxd/nestjs-filter-typeorm';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Post } from './post.entity.js';
import { PostFilter } from './post.filter.js';
import { User } from './user.entity.js';
import { UserFilter } from './user.filter.js';
import { UsersController } from './users.controller.js';

@Module({
  imports: [
    TypeOrmModule.forRoot({
      type: 'postgres',
      host: process.env.DB_HOST ?? 'localhost',
      port: Number(process.env.DB_PORT ?? '5432'),
      username: process.env.DB_USER ?? 'test',
      password: process.env.DB_PASSWORD ?? 'test',
      database: process.env.DB_NAME ?? 'nestjs_filter_test',
      entities: [User, Post],
      synchronize: true,
    }),
    FilterModule.forRoot({ inputNormalizer: 'camelCase' }),
    TypeOrmFilterModule.forRoot(),
    FilterModule.forFeature([UserFilter, PostFilter]),
  ],
  controllers: [UsersController],
})
export class AppModule {}
