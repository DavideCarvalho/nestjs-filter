---
title: Configuration
description: Full FilterModuleOptions reference — forRoot, forRootAsync, forFeature, forFeatureAsync, and per-filter options.
sidebar:
  order: 9
---

## FilterModule.forRoot(options?)

Registers the core filter infrastructure globally. Call once in your root module.

```ts
import { FilterModule } from '@dudousxd/nestjs-filter';

FilterModule.forRoot({
  inputNormalizer: 'camelCase',
  dropId: false,
  onUnknownKey: 'ignore',
  validation: 'auto',
  stripEmpty: true,
})
```

### FilterModuleOptions

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `inputNormalizer` | `'camelCase' \| 'snakeCase' \| (key: string) => string` | `'camelCase'` | How to normalize input keys before dispatch. |
| `dropId` | `boolean` | `true` | Strip trailing `Id` / `_id` from keys (e.g. `companyId` -> `company`). |
| `onUnknownKey` | `'ignore' \| 'warn' \| 'throw'` | `'ignore'` | What to do when an input key has no matching `@FilterFor`. |
| `validation` | `'auto' \| 'off'` | `'auto'` | `'auto'` uses class-validator if installed. `'off'` skips validation. |
| `stripEmpty` | `boolean` | `true` | When `true`, `null`, `undefined`, and empty string values are stripped from input. |

### Input normalizer details

| Value | Behavior | Example |
|-------|----------|---------|
| `'camelCase'` | Converts `snake_case` and `kebab-case` to `camelCase` | `min_age` -> `minAge` |
| `'snakeCase'` | Converts `camelCase` to `snake_case` | `minAge` -> `min_age` |
| `(key) => string` | Custom function | `(key) => key.toLowerCase()` |

### Unknown key policies

| Value | Behavior |
|-------|----------|
| `'ignore'` | Unknown keys are silently skipped. |
| `'warn'` | A warning is logged via NestJS Logger. |
| `'throw'` | An `UnknownFilterKeyException` is thrown. |

---

## FilterModule.forRootAsync(options)

Async variant for dynamic configuration using factories, classes, or existing providers.

### useFactory

```ts
FilterModule.forRootAsync({
  imports: [ConfigModule],
  useFactory: (config: ConfigService) => ({
    inputNormalizer: config.get('FILTER_NORMALIZER', 'camelCase'),
    onUnknownKey: config.get('FILTER_UNKNOWN_KEY', 'ignore'),
  }),
  inject: [ConfigService],
})
```

### useClass

```ts
FilterModule.forRootAsync({
  useClass: FilterConfigService,
})
```

Where `FilterConfigService` implements `FilterModuleOptionsFactory`:

```ts
@Injectable()
class FilterConfigService implements FilterModuleOptionsFactory {
  createFilterOptions(): FilterModuleOptions {
    return { inputNormalizer: 'camelCase' };
  }
}
```

### useExisting

```ts
FilterModule.forRootAsync({
  useExisting: FilterConfigService,
})
```

---

## FilterModule.forFeature(filters)

Registers filter classes with the NestJS DI container. Call once per feature module.

```ts
FilterModule.forFeature([UserFilter, OrderFilter, ProductFilter])
```

Each filter class must be decorated with `@Injectable()` and `@Filterable()`.

---

## FilterModule.forFeatureAsync(options)

Async variant for dynamically determining which filters to register:

```ts
FilterModule.forFeatureAsync({
  imports: [SomeModule],
  useFactory: (service: SomeService) => service.getFilterClasses(),
  inject: [SomeService],
})
```

---

## Per-filter options with @Filterable

Static input key restrictions are configured per-filter via the `@Filterable()` decorator:

```ts
@Filterable({
  entity: User,
  allowed: ['name', 'email', 'status'],
})
```

| Option | Type | Description |
|--------|------|-------------|
| `entity` | `Type<unknown>` | **Required.** The entity class this filter targets. |
| `allowed` | `readonly string[]` | Whitelist of input keys. Only these keys are dispatched. |
| `blocked` | `readonly string[]` | Blacklist of input keys. These keys are never dispatched. |

Note: `allowed` and `blocked` cannot be used together on the same filter.

---

## ORM adapter modules

### MikroOrmFilterModule.forRoot()

Registers the MikroORM adapter. Requires `@mikro-orm/core` EntityManager to be available in the DI container.

```ts
MikroOrmFilterModule.forRoot()
```

### TypeOrmFilterModule.forRoot(dataSourceName?)

Registers the TypeORM adapter. Optionally specify a named DataSource if you have multiple.

```ts
TypeOrmFilterModule.forRoot()           // default DataSource
TypeOrmFilterModule.forRoot('secondary') // named DataSource
```

---

## Edge cases

| Scenario | Behavior |
|----------|----------|
| `null` / `undefined` input | Treated as empty object. Only `setup()` runs. |
| `undefined` value for a key | Key is skipped (not dispatched). |
| `''` (empty string) value | Stripped by default (`stripEmpty: true`). |
| `__proto__` / `constructor` / `prototype` keys | Silently dropped (prototype pollution guard). |
| `allowed` + `blocked` both set | Throws at decorator registration time. |
| `setup()` throws | Wrapped in `FilterMethodException` with `key === 'setup'`. |
| Filter method throws | Wrapped in `FilterMethodException` with the input key and value. |
| No adapter registered | `@ApplyFilter` interceptor throws `FilterMissingAdapterException`. |
| Filter class not in DI | `FilterNotRegisteredException` is thrown. |
| `class-validator` not installed | Validation is silently skipped (auto mode). |
| `dropId: true` on key `'id'` | Key becomes empty string and is dropped entirely. |
