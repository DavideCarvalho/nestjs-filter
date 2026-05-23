import 'reflect-metadata';
import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { FILTER_ADAPTER, FilterModule } from '@dudousxd/nestjs-filter';
import { TypeOrmAdapter } from '../src/typeorm.adapter.js';
import { TypeOrmFilterModule } from '../src/module.js';

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
