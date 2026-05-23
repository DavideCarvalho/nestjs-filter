import 'reflect-metadata';
import { FILTER_ADAPTER, FilterModule } from '@dudousxd/nestjs-filter';
import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { describe, expect, it } from 'vitest';
import { TypeOrmFilterModule } from '../src/module.js';
import { TypeOrmAdapter } from '../src/typeorm.adapter.js';

@Entity('test_items')
class TestItem {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  value!: string;
}

describe('TypeOrmFilterModule', () => {
  it('provides FILTER_ADAPTER as an instance of TypeOrmAdapter', async () => {
    const mod = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot({
          type: 'better-sqlite3',
          database: ':memory:',
          entities: [TestItem],
          synchronize: true,
        }),
        FilterModule.forRoot({ validation: 'off' }),
        TypeOrmFilterModule.forRoot(),
      ],
    }).compile();

    const adapter = mod.get(FILTER_ADAPTER);
    expect(adapter).toBeInstanceOf(TypeOrmAdapter);

    await mod.close();
  });
});
