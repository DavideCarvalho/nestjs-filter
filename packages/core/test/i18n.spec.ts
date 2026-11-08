import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { Controller, Get, Injectable, Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { I18nModule, InMemoryI18nLoader } from '@nestjs/i18n';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { IsNumber, IsOptional } from 'class-validator';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import type { FilterAdapter } from '../src/adapter/adapter.js';
import { BaseFilter } from '../src/base-filter.js';
import { ApplyFilter } from '../src/decorator/apply-filter.decorator.js';
import { FilterFor } from '../src/decorator/filter-for.decorator.js';
import { Filterable } from '../src/decorator/filterable.decorator.js';
import { FilterExceptionFilter } from '../src/filter/filter-exception.filter.js';
import { type FilterTranslator, filterMessage } from '../src/i18n/filter-i18n.js';
import { FILTER_MESSAGES, formatFilterMessage } from '../src/i18n/messages.js';
import { FilterModule } from '../src/module.js';

const catalog = (locale: string) =>
  JSON.parse(readFileSync(new URL(`../i18n/${locale}.json`, import.meta.url), 'utf8')) as {
    filter: Record<string, string>;
  };
const en = catalog('en');
const ptBR = catalog('pt-BR');

describe('shipped catalogs', () => {
  it('en.json is exactly the built-in English', () => {
    expect(en).toEqual({ filter: FILTER_MESSAGES });
  });

  it('pt-BR.json has every key and the same placeholders', () => {
    expect(Object.keys(ptBR.filter).sort()).toEqual(Object.keys(FILTER_MESSAGES).sort());
    const placeholders = (m: string) => [...m.matchAll(/\{(\w+)\}/g)].map((x) => x[1]).sort();
    for (const [key, message] of Object.entries(FILTER_MESSAGES)) {
      expect(placeholders(ptBR.filter[key] as string), key).toEqual(placeholders(message));
    }
  });
});

describe('filterMessage', () => {
  it('fills placeholders and keeps escaped braces in the English fallback', () => {
    expect(filterMessage(undefined, 'operatorNotAllowed', { operator: 'gt', field: 'name' })).toBe(
      'Operator "gt" is not allowed on field "name".',
    );
    expect(filterMessage(undefined, 'histogramSpecRequired')).toBe(
      'histogram requires a `{ field }` specification (with an optional positive `buckets` count).',
    );
    expect(formatFilterMessage('{missing}')).toBe('{missing}');
  });

  it('does not trust translate() for a key the catalogs lack', () => {
    const i18n: FilterTranslator = { exists: () => false, translate: (key) => key };
    expect(filterMessage(i18n, 'invalidSortField', { field: 'x' })).toBe(
      'Invalid sort field: "x".',
    );
  });

  it('falls back to English when the translator throws', () => {
    const i18n: FilterTranslator = {
      exists: () => true,
      translate: () => {
        throw new Error('boom');
      },
    };
    expect(filterMessage(i18n, 'validationFailed')).toBe('Filter input validation failed.');
  });
});

class Entity {}

const adapter: FilterAdapter = {
  createQueryBuilder: () => ({ andWhere: () => undefined }),
  applySort: () => undefined,
};

@Injectable()
@Filterable({ entity: Entity, autoFields: false })
class ItemFilter extends BaseFilter<unknown> {
  static readonly sort = ['name'];

  @IsOptional()
  @IsNumber()
  age?: number;

  @FilterFor('age')
  applyAge() {}
}

@Controller('items')
class ItemsController {
  @Get()
  list(@ApplyFilter(ItemFilter) _q: unknown) {
    return { ok: true };
  }
}

async function makeApp(withI18n: boolean) {
  @Module({
    imports: [
      ...(withI18n
        ? [I18nModule.forRoot({ loader: new InMemoryI18nLoader({ en, 'pt-BR': ptBR }) })]
        : []),
      FilterModule.forRoot({
        inputNormalizer: 'camelCase',
        validation: 'auto',
        throwOnInvalid: true,
        adapter: { useFactory: () => adapter },
      }),
      FilterModule.forFeature([ItemFilter]),
    ],
    controllers: [ItemsController],
    providers: [{ provide: APP_FILTER, useClass: FilterExceptionFilter }],
  })
  class AppModule {}
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = mod.createNestApplication<NestExpressApplication>();
  await app.init();
  return app;
}

describe('with @nestjs/i18n registered', () => {
  it("translates the runner's 400s into the request locale", async () => {
    const app = await makeApp(true);
    const pt = await request(app.getHttpServer())
      .get('/items?sort=age')
      .set('Accept-Language', 'pt-BR');
    expect(pt.status).toBe(400);
    expect(pt.body.message).toBe('Campo de ordenação inválido: "age".');

    const english = await request(app.getHttpServer())
      .get('/items?sort=age')
      .set('Accept-Language', 'en');
    expect(english.body.message).toBe('Invalid sort field: "age".');
    await app.close();
  });

  it('translates FilterExceptionFilter (injected through APP_FILTER)', async () => {
    const app = await makeApp(true);
    const res = await request(app.getHttpServer())
      .get('/items?age=nope')
      .set('Accept-Language', 'pt-BR');
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Falha na validação dos filtros.');
    await app.close();
  });
});

describe('without @nestjs/i18n registered', () => {
  it('keeps the English messages', async () => {
    const app = await makeApp(false);
    const sort = await request(app.getHttpServer())
      .get('/items?sort=age')
      .set('Accept-Language', 'pt-BR');
    expect(sort.status).toBe(400);
    expect(sort.body.message).toBe('Invalid sort field: "age".');
    const validation = await request(app.getHttpServer()).get('/items?age=nope');
    expect(validation.body.message).toBe('Filter input validation failed.');
    await app.close();
  });
});
