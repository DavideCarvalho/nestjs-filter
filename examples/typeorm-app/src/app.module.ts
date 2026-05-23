import { FilterModule } from '@dudousxd/nestjs-filter';
import { TypeOrmFilterModule } from '@dudousxd/nestjs-filter-typeorm';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Post } from './post.entity.js';
import { User } from './user.entity.js';
import { UserFilter } from './user.filter.js';
import { UsersController } from './users.controller.js';

@Module({
  imports: [
    TypeOrmModule.forRoot({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [User, Post],
      synchronize: true,
    }),
    FilterModule.forRoot({ inputNormalizer: 'camelCase' }),
    TypeOrmFilterModule.forRoot(),
    FilterModule.forFeature([UserFilter]),
  ],
  controllers: [UsersController],
})
export class AppModule {}
