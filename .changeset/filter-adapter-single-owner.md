---
'@dudousxd/nestjs-filter': minor
'@dudousxd/nestjs-filter-mikro-orm': minor
'@dudousxd/nestjs-filter-typeorm': minor
---

Give `FILTER_ADAPTER` a single owner, and accept the adapter as config

`FilterModule.forRoot()` registered `{ provide: FILTER_ADAPTER, useValue: null }`
as the no-adapter default, and the adapter modules registered the real adapter for
the *same* token. Both are global, so two providers competed and the winner came
down to container resolution order. That order changed in NestJS 12: constructor
injection began resolving to the `null` default while `app.get(FILTER_ADAPTER)`
still returned the real adapter, so every `@Inject(FILTER_ADAPTER)` consumer
silently received `null` and failed at request time with
`Cannot read properties of null`. NestJS 11 happened to pick the real adapter,
but neither version ever promised an order.

The adapter modules now register a new internal token, `FILTER_ADAPTER_IMPL`, and
`FilterModule` is the only module that provides `FILTER_ADAPTER` — resolving it
from that token, or `null` when no adapter is installed. One provider, nothing to
disambiguate.

`FilterModule.forRoot()` also accepts the adapter directly now:

```ts
import { mikroOrmAdapter } from '@dudousxd/nestjs-filter-mikro-orm';

FilterModule.forRoot({ adapter: mikroOrmAdapter })
```

`typeOrmAdapter(dataSourceName?)` is the TypeORM equivalent. This is the preferred
form — one module instead of two — and it makes registering two adapters for one
token impossible by construction.

Not breaking: `MikroOrmFilterModule` / `TypeOrmFilterModule` keep working unchanged,
and `FILTER_ADAPTER` still resolves to `null` when no adapter is installed. Upgrade
core and the adapter package together — an older adapter package still registers
the public token itself, which reintroduces the ambiguity this release removes.
