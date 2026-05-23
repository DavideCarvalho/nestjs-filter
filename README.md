# @dudousxd/nestjs-filter

NestJS filter library with ORM adapters. Inspired by `adonis-lucid-filter` and `eloquent-filter`, redesigned for NestJS idioms.

**Features:**
- Declarative filter classes with `@FilterFor()` method decorators
- Full NestJS DI inside filters (inject any service)
- Optional class-validator integration (filter = DTO)
- `@ApplyFilter()` param decorator for controllers (method-aware: GET=query, POST=body+query)
- AsyncLocalStorage-based state isolation (singleton filters, zero cross-request contamination)
- ORM-agnostic core with native QueryBuilder access per adapter

## Packages

| Package | Description |
|---------|-------------|
| `@dudousxd/nestjs-filter` | Core: BaseFilter, FilterRunner, decorators, FilterModule |
| `@dudousxd/nestjs-filter-mikro-orm` | MikroORM 7 adapter |
| `@dudousxd/nestjs-filter-typeorm` | TypeORM adapter |

## Install

```bash
# MikroORM
pnpm add @dudousxd/nestjs-filter @dudousxd/nestjs-filter-mikro-orm

# TypeORM
pnpm add @dudousxd/nestjs-filter @dudousxd/nestjs-filter-typeorm
```

## Quick start

```typescript
// 1. Define a filter
@Injectable()
@Filterable({ entity: User })
export class UserFilter extends MikroOrmFilter<User> {
  @IsOptional() @IsString()
  name?: string;

  @FilterFor('name')
  applyName(value: string) {
    this.$query.andWhere({ name: { $like: `%${value}%` } });
  }
}

// 2. Register
@Module({
  imports: [
    FilterModule.forRoot(),
    MikroOrmFilterModule.forRoot(),
    FilterModule.forFeature([UserFilter]),
  ],
})
export class AppModule {}

// 3. Use in controller
@Controller('users')
export class UsersController {
  @Get()
  list(@ApplyFilter(UserFilter) qb: QueryBuilder<User>) {
    return qb.getResultList();
  }
}
```

See `examples/mikro-orm-app` and `examples/typeorm-app` for complete working setups.

## License

MIT
