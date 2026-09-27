import 'reflect-metadata';
import { FILTER_ADAPTER, FilterModule } from '@dudousxd/nestjs-filter';
import { Global, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { drizzle } from 'drizzle-orm/node-postgres';
import { describe, expect, it } from 'vitest';
import { DrizzleAdapter } from '../src/drizzle.adapter.js';
import { DrizzleFilterModule, drizzleAdapter } from '../src/module.js';

const DRIZZLE = Symbol('DRIZZLE');
const db = drizzle.mock();

// Drizzle has no Nest module of its own; apps typically expose the db from a
// @Global() module like this one.
@Global()
@Module({ providers: [{ provide: DRIZZLE, useValue: db }], exports: [DRIZZLE] })
class DatabaseModule {}

@Module({ providers: [{ provide: DRIZZLE, useValue: db }], exports: [DRIZZLE] })
class LocalDatabaseModule {}

describe('DrizzleFilterModule', () => {
  it('forRoot({ connection }) injects the app-provided db token', async () => {
    const mod = await Test.createTestingModule({
      imports: [
        DatabaseModule,
        FilterModule.forRoot({ validation: 'off' }),
        DrizzleFilterModule.forRoot({ connection: DRIZZLE }),
      ],
    }).compile();
    const adapter = mod.get<DrizzleAdapter>(FILTER_ADAPTER);
    expect(adapter).toBeInstanceOf(DrizzleAdapter);
    expect(adapter.db).toBe(db);
    expect(adapter.dialect).toBe('postgres');
    await mod.close();
  });

  it('forRoot({ connection, imports }) resolves the token from a non-global module', async () => {
    const mod = await Test.createTestingModule({
      imports: [
        FilterModule.forRoot({ validation: 'off' }),
        DrizzleFilterModule.forRoot({ connection: DRIZZLE, imports: [LocalDatabaseModule] }),
      ],
    }).compile();
    expect(mod.get<DrizzleAdapter>(FILTER_ADAPTER).db).toBe(db);
    await mod.close();
  });

  it('forRoot({ db }) takes the instance directly', async () => {
    const mod = await Test.createTestingModule({
      imports: [
        FilterModule.forRoot({ validation: 'off' }),
        DrizzleFilterModule.forRoot({ db, dialect: 'postgres' }),
      ],
    }).compile();
    expect(mod.get(FILTER_ADAPTER)).toBeInstanceOf(DrizzleAdapter);
    await mod.close();
  });
});

describe('drizzleAdapter descriptor', () => {
  it('registers the adapter through FilterModule.forRoot({ adapter })', async () => {
    const mod = await Test.createTestingModule({
      imports: [
        DatabaseModule,
        FilterModule.forRoot({
          validation: 'off',
          adapter: drizzleAdapter({ connection: DRIZZLE }),
        }),
      ],
    }).compile();
    const adapter = mod.get<DrizzleAdapter>(FILTER_ADAPTER);
    expect(adapter).toBeInstanceOf(DrizzleAdapter);
    expect(adapter.db).toBe(db);
    await mod.close();
  });

  it('accepts a db instance', async () => {
    const mod = await Test.createTestingModule({
      imports: [FilterModule.forRoot({ validation: 'off', adapter: drizzleAdapter({ db }) })],
    }).compile();
    expect(mod.get(FILTER_ADAPTER)).toBeInstanceOf(DrizzleAdapter);
    await mod.close();
  });
});
