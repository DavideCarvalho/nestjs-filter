---
title: CLI Reference
description: The nestjs-filter CLI — generate filter scaffolds with a single command.
---

nestjs-filter includes a CLI for generating filter class scaffolds.

## Generate a filter

```bash
npx nestjs-filter generate <name> [--orm=mikro-orm|typeorm]
```

### Arguments

| Argument | Description |
|----------|-------------|
| `<name>` | The entity name (e.g., `user`, `order`, `product`). Used to derive class names and file paths. |

### Options

| Option | Default | Description |
|--------|---------|-------------|
| `--orm` | `mikro-orm` | Which ORM adapter to use. Determines the base class and import. |

### Aliases

The `generate` command can also be invoked as `g`:

```bash
npx nestjs-filter g user --orm=typeorm
```

### Output

The command creates a filter file at `src/<name>.filter.ts`:

#### MikroORM (default)

```bash
npx nestjs-filter generate user
```

Generates `src/user.filter.ts`:

```ts
import { Injectable } from '@nestjs/common';
import { Filterable, FilterFor } from '@dudousxd/nestjs-filter';
import { MikroOrmFilter } from '@dudousxd/nestjs-filter-mikro-orm';
import { User } from './user.entity.js';

@Injectable()
@Filterable({ entity: User })
export class UserFilter extends MikroOrmFilter<User> {
  // @FilterFor('fieldName')
  // applyField(value: string) {
  //   this.$query.andWhere({ field: value });
  // }
}
```

#### TypeORM

```bash
npx nestjs-filter generate user --orm=typeorm
```

Generates `src/user.filter.ts`:

```ts
import { Injectable } from '@nestjs/common';
import { Filterable, FilterFor } from '@dudousxd/nestjs-filter';
import { TypeOrmFilter } from '@dudousxd/nestjs-filter-typeorm';
import { User } from './user.entity.js';

@Injectable()
@Filterable({ entity: User })
export class UserFilter extends TypeOrmFilter<User> {
  // @FilterFor('fieldName')
  // applyField(value: string) {
  //   this.$query.andWhere({ field: value });
  // }
}
```

### Behavior

- The entity name is PascalCased for the class name (e.g., `user` becomes `User`, `UserFilter`).
- If the output file already exists, the command prints an error and exits without overwriting.
- The `src/` directory is created if it does not exist.
- The generated filter assumes a co-located entity file at `src/<name>.entity.ts`.

### After generating

After generating a filter, you need to:

1. Register the filter with `FilterModule.forFeature([UserFilter])` in your module
2. Add your `@FilterFor()` methods to the generated class
3. Optionally add `class-validator` decorators for input validation
