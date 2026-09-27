import { FilterModule } from '@dudousxd/nestjs-filter';
import { drizzleAdapter } from '@dudousxd/nestjs-filter-drizzle';
import { Module } from '@nestjs/common';
import { DRIZZLE, DatabaseModule } from './database.module.js';
import { PostFilter } from './post.filter.js';
import { schema } from './schema.js';
import { UserFilter } from './user.filter.js';
import { UsersController } from './users.controller.js';

@Module({
  imports: [
    DatabaseModule,
    FilterModule.forRoot({
      inputNormalizer: 'camelCase',
      adapter: drizzleAdapter({ connection: DRIZZLE, schema }),
    }),
    FilterModule.forFeature([UserFilter, PostFilter]),
  ],
  controllers: [UsersController],
})
export class AppModule {}
