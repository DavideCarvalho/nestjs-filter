---
title: nestjs-inertia Integration
description: Type-safe filtering with nestjs-inertia codegen — automatic TypedFilterQuery generation from @ApplyFilter decorators.
sidebar:
  order: 10
---

## Overview

When used with [@dudousxd/nestjs-inertia](https://davidecarvalho.github.io/nestjs-inertia/), the codegen automatically detects `@ApplyFilter` decorators and generates type-safe filter queries for the frontend.

No configuration needed. Install both libraries and the codegen handles everything.

## How it works

### Backend: define your filter and controller

```ts
// pipeline-run.filter.ts
import { Injectable } from '@nestjs/common';
import { Filterable, FilterFor } from '@dudousxd/nestjs-filter';
import { MikroOrmFilter } from '@dudousxd/nestjs-filter-mikro-orm';
import { PipelineRun } from './pipeline-run.entity';

@Injectable()
@Filterable({ entity: PipelineRun })
export class PipelineRunFilter extends MikroOrmFilter<PipelineRun> {
  @FilterFor('search')
  applySearch(value: string) {
    this.whereLike('name', value);
  }
}
```

```ts
// pipeline-runs.controller.ts
import { Controller, Get, Post } from '@nestjs/common';
import { ApplyFilter } from '@dudousxd/nestjs-filter';
import { PipelineRunFilter } from './pipeline-run.filter';

@Controller('/api/pipeline-runs')
export class PipelineRunsController {
  @Get()
  list(@ApplyFilter(PipelineRunFilter) qb: QueryBuilder) {
    return qb.getResultList();
  }

  @Post('search')
  search(@ApplyFilter(PipelineRunFilter, { source: 'body' }) qb: QueryBuilder) {
    return qb.getResultList();
  }
}
```

With `autoFields` enabled by default, the codegen introspects the entity and generates fields plus relation paths like `tasks.status` and `tasks.name` automatically.

### Codegen generates typed queries

The nestjs-inertia codegen scans your controllers and generates:

```ts
// Generated api.ts
pipelineRuns: {
  list: {
    method: 'GET';
    query: TypedFilterQuery<
      'name' | 'status' | 'createdAt' | 'tasks.status' | 'tasks.name'
    >;
  },
  search: {
    method: 'POST';
    body: FilterQueryResult<
      'name' | 'status' | 'createdAt' | 'tasks.status' | 'tasks.name'
    >;
  }
}
```

Dot-notation fields (e.g. `tasks.status`) are generated from entity relations -- the library auto-joins the required tables.

### Frontend: fully type-safe

Use the generated types with TanStack Query for autocompleted, compile-time-checked filter queries:

```tsx
import { useQuery } from '@tanstack/react-query';
import { api } from '~codegen/api';

function PipelineRunList() {
  // Simple structured input — all fields are autocompleted
  const { data } = useQuery(
    api.pipelineRuns.list.queryOptions({
      filter: { name: 'nightly', status: 'RUNNING' },
      sort: ['-createdAt'],
      paginate: { page: 0, size: 25 },
      search: 'nightly',
      include: ['tasks'],
    })
  );

  // Or use the fluent builder for complex queries
  const query = api.pipelineRuns.list.filterQuery();
  query.contains('name', 'nightly');
  query.in('status', ['RUNNING', 'COMPLETED']);
  query.sort('createdAt', 'desc');
  query.page(0, 25);

  const { data: results } = useQuery(
    api.pipelineRuns.list.queryOptions(query.build())
  );

  return <ul>{results?.map(r => <li key={r.id}>{r.name}</li>)}</ul>;
}
```

## Setup

1. Install both libraries:
   ```bash
   pnpm add @dudousxd/nestjs-filter @dudousxd/nestjs-filter-client @dudousxd/nestjs-inertia
   ```
2. Run codegen:
   ```bash
   npx nestjs-inertia codegen
   ```
3. Use the generated types -- field names are autocompleted and invalid fields produce compile errors.

Without `@dudousxd/nestjs-filter-client` installed, the codegen defaults to `query: never` for filtered routes -- no error, just absent filter typing.

## Links

- [nestjs-inertia docs](https://davidecarvalho.github.io/nestjs-inertia/)
- [nestjs-inertia filter recipe](https://davidecarvalho.github.io/nestjs-inertia/recipes/nestjs-filter/)
- [Client package reference](/nestjs-filter/packages/client/)
