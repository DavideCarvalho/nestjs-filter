import 'reflect-metadata';
import { FilterModule, FilterRunner, Filterable } from '@dudousxd/nestjs-filter';
import { Collection, DateType, MikroORM } from '@mikro-orm/core';
import {
  Entity,
  ManyToOne,
  OneToMany,
  PrimaryKey,
  Property,
  ReflectMetadataProvider,
} from '@mikro-orm/decorators/legacy';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { SqliteDriver } from '@mikro-orm/sqlite';
import { Injectable } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { MikroOrmFilter } from '../src/mikro-orm-filter.js';
import { MikroOrmFilterModule } from '../src/module.js';

// ─── Entities ───────────────────────────────────────────────────────────────────

@Entity({ tableName: 'vehicles' })
class Vehicle {
  @PrimaryKey()
  id!: number;

  @Property()
  name!: string;

  @OneToMany(
    () => Visit,
    (visit) => visit.vehicle,
  )
  visits = new Collection<Visit>(this);
}

@Entity({ tableName: 'visits' })
class Visit {
  @PrimaryKey()
  id!: number;

  /** The date child column this suite is about. */
  @Property({ type: 'Date' })
  servicedAt!: Date;

  /**
   * A DATE column declared the way a date-only column usually is: MikroORM's
   * `DateType` maps it to a `'YYYY-MM-DD'` **string**, so its `runtimeType` is
   * `string`, not `Date` (only `DateTimeType` reflects as `Date`). Classifying
   * off the runtime type alone made this a `'string'` column and silently
   * excluded it from the date aggregates.
   */
  @Property({ type: DateType, columnType: 'date', nullable: true })
  inspectedOn?: string | null;

  /** A numeric child column — the type that always qualified. */
  @Property()
  cost!: number;

  /** A string child column — must never qualify for any aggregate. */
  @Property()
  note!: string;

  @ManyToOne(() => Vehicle)
  vehicle!: Vehicle;
}

// ─── Filter ─────────────────────────────────────────────────────────────────────

@Injectable()
@Filterable({ entity: Vehicle, autoFields: true })
class VehicleFilter extends MikroOrmFilter<Vehicle> {}

// ─── Test Suite ─────────────────────────────────────────────────────────────────

/**
 * `$min`/`$max` over a DATE child column.
 *
 * `addAggregateAutoFields` used to synthesize aggregate keys only for NUMERIC
 * child columns, on the reasoning that `SUM`/`AVG`/`MIN`/`MAX` over anything
 * else "is either a SQL error or nonsensical". That is true of the arithmetic
 * pair but not of the order-based one: "the earliest / latest child date" is
 * valid SQL and a routinely useful filter. Because the synthesized set is also
 * the allowlist that gates explicitly-passed aggregate paths, a date `$max`
 * was not merely un-suggested — it was rejected outright, forcing consumers
 * into a hand-written `computed` correlated subquery.
 *
 * Strings/booleans/json still never qualify: that keeps the second, still-valid
 * reason for the original rule — not letting a client probe arbitrary child
 * columns through the aggregate path.
 */
describe('MikroORM to-many aggregates over DATE child columns', () => {
  let orm: MikroORM;
  let runner: FilterRunner;

  async function createModule() {
    const mod = await Test.createTestingModule({
      imports: [
        MikroOrmModule.forRoot({
          driver: SqliteDriver,
          dbName: ':memory:',
          entities: [Vehicle, Visit],
          allowGlobalContext: true,
          metadataProvider: ReflectMetadataProvider,
        }),
        FilterModule.forRoot({ validation: 'off' }),
        MikroOrmFilterModule.forRoot(),
        FilterModule.forFeature([VehicleFilter]),
      ],
    }).compile();

    orm = mod.get(MikroORM);
    runner = mod.get(FilterRunner);
    await orm.schema.create();
    return mod;
  }

  // Truck  → visits 2019-03-01 (100) and 2021-06-30 (200) — min 2019, max 2021
  // Van    → visit  2022-12-25 (500)                      — min = max = 2022
  // Trailer→ no visits at all                             — aggregates are NULL
  //
  // Costs are deliberately NOT symmetric (Truck sums to 300, Van to 500) so no
  // numeric threshold below happens to match both vehicles.
  async function seed() {
    const em = orm.em.fork();
    const truck = em.create(Vehicle, { name: 'Truck' });
    const van = em.create(Vehicle, { name: 'Van' });
    const trailer = em.create(Vehicle, { name: 'Trailer' });
    em.persist([truck, van, trailer]);
    em.create(Visit, {
      servicedAt: new Date('2019-03-01'),
      inspectedOn: '2019-03-01',
      cost: 100,
      note: 'a',
      vehicle: truck,
    });
    em.create(Visit, {
      servicedAt: new Date('2021-06-30'),
      inspectedOn: '2021-06-30',
      cost: 200,
      note: 'b',
      vehicle: truck,
    });
    em.create(Visit, {
      servicedAt: new Date('2022-12-25'),
      inspectedOn: '2022-12-25',
      cost: 500,
      note: 'c',
      vehicle: van,
    });
    await em.flush();
  }

  async function namesFor(input: unknown): Promise<string[]> {
    const qb = orm.em.fork().createQueryBuilder(Vehicle);
    await runner.apply(VehicleFilter, input as never, qb);
    const rows = await qb.getResult();
    return rows.map((r) => r.name).sort();
  }

  afterEach(async () => {
    await orm?.close(true);
  });

  it('filters by $max over a date child column', async () => {
    const mod = await createModule();
    await seed();

    // Last visit on/after 2022 — only the Van. The bound is a real `Date`:
    // MikroORM stores a `Date` property as a timestamp, so a string literal
    // would compare against the wrong type and match nothing.
    expect(
      await namesFor({ filter: { 'visits.$max.servicedAt': { gte: new Date('2022-01-01') } } }),
    ).toEqual(['Van']);

    await mod.close();
  });

  it('filters by $min over a date child column', async () => {
    const mod = await createModule();
    await seed();

    // First visit before 2020 — only the Truck. `$min` and `$max` must be
    // independent: the Truck's $max (2021) does NOT satisfy this.
    expect(
      await namesFor({ filter: { 'visits.$min.servicedAt': { lt: new Date('2020-01-01') } } }),
    ).toEqual(['Truck']);

    await mod.close();
  });

  it('sorts by $max over a date child column', async () => {
    const mod = await createModule();
    await seed();

    const qb = orm.em.fork().createQueryBuilder(Vehicle);
    await runner.apply(
      VehicleFilter,
      { sort: [{ field: 'visits.$max.servicedAt', direction: 'desc' }] } as never,
      qb,
    );
    const names = (await qb.getResult()).map((r) => r.name);

    // Van (2022) then Truck (2021); the Trailer has no visits, so its NULL
    // aggregate lands last on DESC. Insertion order was Truck, Van, Trailer —
    // so this cannot pass on the default row order.
    expect(names.slice(0, 2)).toEqual(['Van', 'Truck']);
    expect(names).toHaveLength(3);

    await mod.close();
  });

  it('still accepts every aggregate over a numeric child column', async () => {
    const mod = await createModule();
    await seed();

    // Regression guard: widening to dates must not narrow the numeric set.
    // Bounded on both sides on purpose: the Trailer has no visits, and an
    // empty `$sum` compares as 0 rather than dropping out, so a bare `lte`
    // would sweep it in.
    expect(await namesFor({ filter: { 'visits.$sum.cost': { gte: 300, lte: 400 } } })).toEqual([
      'Truck',
    ]);
    expect(await namesFor({ filter: { 'visits.$avg.cost': { gte: 250 } } })).toEqual(['Van']);
    expect(await namesFor({ filter: { 'visits.$min.cost': { lte: 100 } } })).toEqual(['Truck']);
    expect(await namesFor({ filter: { 'visits.$max.cost': { gte: 500 } } })).toEqual(['Van']);

    await mod.close();
  });

  it('treats a DateType (string runtime) column as a date, not a string', async () => {
    const mod = await createModule();
    await seed();

    // The regression that made this fix land short in practice: `DateType`
    // maps a DATE column to a 'YYYY-MM-DD' string, so classifying off the
    // reflected runtime type alone called it `'string'` and no aggregate was
    // synthesized. The DB column type is authoritative.
    expect(
      await namesFor({ filter: { 'visits.$max.inspectedOn': { gte: '2022-01-01' } } }),
    ).toEqual(['Van']);
    expect(await namesFor({ filter: { 'visits.$min.inspectedOn': { lt: '2020-01-01' } } })).toEqual(
      ['Truck'],
    );

    // Still no arithmetic over it, same as any other date column.
    expect(await namesFor({ filter: { 'visits.$sum.inspectedOn': { gte: 1 } } })).toEqual([
      'Trailer',
      'Truck',
      'Van',
    ]);

    await mod.close();
  });

  it('rejects $sum/$avg over a date child column', async () => {
    const mod = await createModule();
    await seed();

    // Arithmetic over a date stays out: not synthesized, so not in the
    // allowlist, so dropped as an unknown key — every vehicle comes back.
    expect(await namesFor({ filter: { 'visits.$sum.servicedAt': { gte: 1 } } })).toEqual([
      'Trailer',
      'Truck',
      'Van',
    ]);
    expect(await namesFor({ filter: { 'visits.$avg.servicedAt': { gte: 1 } } })).toEqual([
      'Trailer',
      'Truck',
      'Van',
    ]);

    await mod.close();
  });

  it('rejects aggregates over a string child column', async () => {
    const mod = await createModule();
    await seed();

    // The probing guard: a client must not be able to reach arbitrary child
    // columns through the aggregate path just because MIN/MAX would parse.
    expect(await namesFor({ filter: { 'visits.$max.note': { equals: 'c' } } })).toEqual([
      'Trailer',
      'Truck',
      'Van',
    ]);

    await mod.close();
  });
});

/**
 * Aggregate paths arriving through the `where[]` column-filter path.
 *
 * `where[]` is what the typed client builder's `.where()` emits, and codegen
 * puts aggregate paths in the field union — so `.where('visits.$max.servicedAt',
 * …)` typechecks. It used to fail before reaching any adapter:
 * `validateColumnFilter`'s field-name grammar allows only letters, digits,
 * underscores and dots, so the `$` was rejected outright with an
 * InvalidColumnFilterError. Aggregate dispatch only ever happened on the
 * structured filter object.
 */
describe('MikroORM to-many aggregates via the where[] column-filter path', () => {
  let orm: MikroORM;
  let runner: FilterRunner;

  async function createModule() {
    const mod = await Test.createTestingModule({
      imports: [
        MikroOrmModule.forRoot({
          driver: SqliteDriver,
          dbName: ':memory:',
          entities: [Vehicle, Visit],
          allowGlobalContext: true,
          metadataProvider: ReflectMetadataProvider,
        }),
        FilterModule.forRoot({ validation: 'off' }),
        MikroOrmFilterModule.forRoot(),
        FilterModule.forFeature([VehicleFilter]),
      ],
    }).compile();

    orm = mod.get(MikroORM);
    runner = mod.get(FilterRunner);
    await orm.schema.create();
    return mod;
  }

  async function seedVehicles() {
    const em = orm.em.fork();
    const truck = em.create(Vehicle, { name: 'Truck' });
    const van = em.create(Vehicle, { name: 'Van' });
    em.persist([truck, van]);
    em.create(Visit, {
      servicedAt: new Date('2019-03-01'),
      inspectedOn: '2019-03-01',
      cost: 100,
      note: 'a',
      vehicle: truck,
    });
    em.create(Visit, {
      servicedAt: new Date('2022-12-25'),
      inspectedOn: '2022-12-25',
      cost: 500,
      note: 'c',
      vehicle: van,
    });
    await em.flush();
  }

  async function namesForWhere(where: unknown[]): Promise<string[]> {
    const qb = orm.em.fork().createQueryBuilder(Vehicle);
    await runner.apply(VehicleFilter, { filter: { where } } as never, qb);
    return (await qb.getResult()).map((r) => r.name).sort();
  }

  afterEach(async () => {
    await orm?.close(true);
  });

  it('filters on an aggregate path sent as a where[] clause', async () => {
    const mod = await createModule();
    await seedVehicles();

    // The whole point: this used to throw InvalidColumnFilterError on the `$`.
    expect(
      await namesForWhere([
        { field: 'visits.$max.servicedAt', operator: 'gte', value: new Date('2022-01-01') },
      ]),
    ).toEqual(['Van']);

    await mod.close();
  });

  it('works for a DateType column and ANDs with plain clauses', async () => {
    const mod = await createModule();
    await seedVehicles();

    expect(
      await namesForWhere([
        { field: 'visits.$min.inspectedOn', operator: 'lt', value: '2020-01-01' },
        { field: 'name', operator: 'equals', value: 'Truck' },
      ]),
    ).toEqual(['Truck']);

    // Same aggregate, name clause that excludes the only match — proves both
    // halves are really applied.
    expect(
      await namesForWhere([
        { field: 'visits.$min.inspectedOn', operator: 'lt', value: '2020-01-01' },
        { field: 'name', operator: 'equals', value: 'Van' },
      ]),
    ).toEqual([]);

    await mod.close();
  });

  it('still rejects an aggregate over a column that is not aggregatable', async () => {
    const mod = await createModule();
    await seedVehicles();

    // The auto-field allowlist gates where[] exactly as it gates the
    // structured path — otherwise this would be a hole for reaching arbitrary
    // child columns. `note` is a string, so it is not in the set and the
    // clause is dropped rather than honored.
    expect(
      await namesForWhere([{ field: 'visits.$max.note', operator: 'equals', value: 'c' }]),
    ).toEqual(['Truck', 'Van']);

    await mod.close();
  });

  it('leaves a field that merely contains $ to normal validation', async () => {
    const mod = await createModule();
    await seedVehicles();

    // Not a valid aggregate path, so it must NOT be routed to the aggregate
    // branch — it falls through to the column-filter grammar, which rejects it.
    await expect(
      namesForWhere([{ field: 'visits.$notafn', operator: 'equals', value: 1 }]),
    ).rejects.toThrow();

    await mod.close();
  });
});
