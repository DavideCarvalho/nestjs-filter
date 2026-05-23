---
title: Installation
description: Install nestjs-filter packages with pnpm, npm, or yarn, and understand peer dependencies.
sidebar:
  order: 1
---

## Per-ORM install commands

### MikroORM

```bash
# pnpm (recommended)
pnpm add @dudousxd/nestjs-filter @dudousxd/nestjs-filter-mikro-orm

# npm
npm install @dudousxd/nestjs-filter @dudousxd/nestjs-filter-mikro-orm

# yarn
yarn add @dudousxd/nestjs-filter @dudousxd/nestjs-filter-mikro-orm
```

### TypeORM

```bash
# pnpm (recommended)
pnpm add @dudousxd/nestjs-filter @dudousxd/nestjs-filter-typeorm

# npm
npm install @dudousxd/nestjs-filter @dudousxd/nestjs-filter-typeorm

# yarn
yarn add @dudousxd/nestjs-filter @dudousxd/nestjs-filter-typeorm
```

## Optional validation packages

If you want your filter class to double as a validated DTO, install `class-validator` and `class-transformer`:

```bash
pnpm add class-validator class-transformer
```

When these packages are installed and `validation` is set to `'auto'` (the default), input is automatically validated before dispatch. If they are not installed, validation is silently skipped.

## Peer dependencies

| Peer dep | Required by | Condition |
|----------|-------------|-----------|
| `@nestjs/common >=10` | core | always |
| `@nestjs/core >=10` | core | always |
| `reflect-metadata` | core | always (NestJS standard) |
| `@mikro-orm/core >=6` | mikro-orm adapter | MikroORM projects |
| `@mikro-orm/sql` | mikro-orm adapter | MikroORM projects |
| `typeorm >=0.3` | typeorm adapter | TypeORM projects |
| `@nestjs/typeorm >=10` | typeorm adapter | TypeORM projects |
| `class-validator` | core (optional) | validation mode `'auto'` |
| `class-transformer` | core (optional) | validation mode `'auto'` |

## TypeScript configuration

Your `tsconfig.json` must enable decorator metadata:

```json
{
  "compilerOptions": {
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true,
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true
  }
}
```

Both `experimentalDecorators` and `emitDecoratorMetadata` are required for the decorator-based API (`@Filterable`, `@FilterFor`, `@ApplyFilter`, `@Relations`).

## Engine requirements

All packages require **Node.js >= 20**. NestJS 10 and 11 are both supported.
