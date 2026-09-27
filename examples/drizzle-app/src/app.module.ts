import { FilterModule } from '@dudousxd/nestjs-filter';
import { DrizzleFilterModule } from '@dudousxd/nestjs-filter-drizzle';
import { Module } from '@nestjs/common';
import { DRIZZLE, DatabaseModule } from './database.module.js';
import { UserFilter } from './user.filter.js';
import { UsersController } from './users.controller.js';

@Module({
  imports: [
    DatabaseModule,
    FilterModule.forRoot({ inputNormalizer: 'camelCase' }),
    // The schema passed to drizzle() is read off the db instance; pass
    // `schema` here only if the db was created without one.
    DrizzleFilterModule.forRoot({ connection: DRIZZLE }),
    FilterModule.forFeature([UserFilter]),
  ],
  controllers: [UsersController],
})
export class AppModule {}
