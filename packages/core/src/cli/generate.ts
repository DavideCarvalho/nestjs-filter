#!/usr/bin/env node
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const command = args[0];
const name = args[1];
const ormArg = args.find((a) => a.startsWith('--orm='));
const orm = ormArg?.split('=')[1] ?? 'mikro-orm';

if (!command || !name || !['generate', 'g'].includes(command)) {
  console.log('Usage: npx nestjs-filter generate <name> [--orm=mikro-orm|typeorm]');
  process.exit(1);
}

const pascal = name.charAt(0).toUpperCase() + name.slice(1);
const filterImport =
  orm === 'typeorm'
    ? "import { TypeOrmFilter } from '@dudousxd/nestjs-filter-typeorm';"
    : "import { MikroOrmFilter } from '@dudousxd/nestjs-filter-mikro-orm';";
const baseClass = orm === 'typeorm' ? `TypeOrmFilter<${pascal}>` : `MikroOrmFilter<${pascal}>`;

const template = `import { Injectable } from '@nestjs/common';
import { Filterable, FilterFor } from '@dudousxd/nestjs-filter';
${filterImport}
import { ${pascal} } from './${name}.entity.js';

@Injectable()
@Filterable({ entity: ${pascal} })
export class ${pascal}Filter extends ${baseClass} {
  // @FilterFor('fieldName')
  // applyField(value: string) {
  //   this.$query.andWhere({ field: value });
  // }
}
`;

const outDir = join(process.cwd(), 'src');
const outPath = join(outDir, `${name}.filter.ts`);

if (existsSync(outPath)) {
  console.error(`File already exists: ${outPath}`);
  process.exit(1);
}

if (!existsSync(outDir)) {
  mkdirSync(outDir, { recursive: true });
}

writeFileSync(outPath, template);
console.log(`Created ${outPath}`);
