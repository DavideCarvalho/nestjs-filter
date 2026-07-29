import 'reflect-metadata';
import { FilterModule, FilterRunner } from '@dudousxd/nestjs-filter';
import { Collection, MikroORM } from '@mikro-orm/core';
import {
  Entity,
  ManyToMany,
  ManyToOne,
  OneToMany,
  PrimaryKey,
  Property,
  ReflectMetadataProvider,
} from '@mikro-orm/decorators/legacy';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { SqliteDriver } from '@mikro-orm/sqlite';
import { Test } from '@nestjs/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { MikroOrmFilterModule } from '../src/module.js';

@Entity({ tableName: 'distinct_many_tags' })
class Tag {
  @PrimaryKey()
  id!: number;

  @Property()
  label!: string;
}

@Entity({ tableName: 'distinct_many_people' })
class Person {
  @PrimaryKey()
  id!: number;

  @Property()
  name!: string;

  @Property()
  rank!: string;

  @OneToMany(
    () => Event,
    (event) => event.person,
  )
  events = new Collection<Event>(this);

  @ManyToMany(() => Tag)
  tags = new Collection<Tag>(this);
}

@Entity({ tableName: 'distinct_many_events' })
class Event {
  @PrimaryKey()
  id!: number;

  @Property()
  reason!: string;

  @ManyToOne(() => Person)
  person!: Person;
}

/**
 * A to-many path under DISTINCT.
 *
 * The join multiplies the PARENT rows, which is why the rows route must never
 * do this — but a distinct projection returns one column and collapses exactly
 * those duplicates. "Which leave reasons appear among the people matching these
 * filters?" is the question a filter dropdown asks, and this is the join that
 * answers it.
 */
describe('distinct over a to-many path (MikroORM)', () => {
  let orm: MikroORM;
  let runner: FilterRunner;

  async function createModule() {
    const mod = await Test.createTestingModule({
      imports: [
        MikroOrmModule.forRoot({
          driver: SqliteDriver,
          dbName: ':memory:',
          entities: [Person, Event, Tag],
          allowGlobalContext: true,
          metadataProvider: ReflectMetadataProvider,
        }),
        FilterModule.forRoot({ validation: 'off' }),
        MikroOrmFilterModule.forRoot(),
      ],
    }).compile();
    orm = mod.get(MikroORM);
    runner = mod.get(FilterRunner);
    await orm.schema.create();
    return mod;
  }

  async function seed() {
    const em = orm.em.fork();
    const leave = em.create(Tag, { id: 1, label: 'leave' });
    const duty = em.create(Tag, { id: 2, label: 'duty' });

    const ada = em.create(Person, { id: 1, name: 'Ada', rank: 'SSgt' });
    const grace = em.create(Person, { id: 2, name: 'Grace', rank: 'TSgt' });
    // Nobody's events: a person with none must not break the projection.
    em.create(Person, { id: 3, name: 'Alan', rank: 'SSgt' });

    // Ada has TWO events sharing a reason — the duplicate the join creates and
    // DISTINCT must collapse.
    em.create(Event, { id: 1, reason: 'medical', person: ada });
    em.create(Event, { id: 2, reason: 'medical', person: ada });
    em.create(Event, { id: 3, reason: 'training', person: grace });

    ada.tags.add(leave, duty);
    grace.tags.add(duty);
    await em.flush();
  }

  afterEach(async () => {
    if (orm) await orm.close(true);
  });

  function values(rows: unknown[], key: string): unknown[] {
    return (rows as Array<Record<string, unknown>>)
      .map((row) => row[key])
      .filter((value) => value != null);
  }

  it('projects a one-to-many column and collapses the join duplicates', async () => {
    await createModule();
    await seed();

    const { rows } = await runner.findAndCount(Person, {
      filter: {},
      distinct: 'events.reason',
      sort: 'events.reason',
    });

    // Ada's two `medical` events collapse into one option.
    expect(values(rows, 'events.reason')).toEqual(['medical', 'training']);
  });

  it('narrows the options by a filter on the PARENT', async () => {
    await createModule();
    await seed();

    const { rows } = await runner.findAndCount(Person, {
      filter: { where: [{ field: 'rank', operator: 'equals', value: 'TSgt' }] },
      distinct: 'events.reason',
    });

    // Only Grace is a TSgt, so only her reason is on offer — the whole point of
    // sourcing dropdown options from the data instead of a static list.
    expect(values(rows, 'events.reason')).toEqual(['training']);
  });

  it('projects a many-to-many column through its pivot', async () => {
    await createModule();
    await seed();

    const { rows } = await runner.findAndCount(Person, {
      filter: {},
      distinct: 'tags.label',
      sort: 'tags.label',
    });

    // `duty` is on two people and must appear once.
    expect(values(rows, 'tags.label')).toEqual(['duty', 'leave']);
  });

  it('counts distinct VALUES, not parent rows', async () => {
    await createModule();
    await seed();

    const { total } = await runner.findAndCount(Person, {
      filter: { where: [{ field: 'events.reason', operator: 'isNotNull' }] },
      distinct: 'events.reason',
    });

    // Three event rows, two distinct reasons.
    expect(total).toBe(2);
  });
});
