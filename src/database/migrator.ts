import { Umzug, SequelizeStorage } from 'umzug';
import type { QueryInterface } from 'sequelize';
import sequelize from './db.js';
import * as initialSchema from './migrations/20261107-0001-initial-schema.js';

// Migrations are listed explicitly (not globbed) so the same list works from src/ under tsx and from dist/ in production.
const migrations = [
  { name: '20261107-0001-initial-schema', module: initialSchema },
];

export const migrator = new Umzug<QueryInterface>({
  migrations: migrations.map(({ name, module }) => ({
    name,
    up: ({ context }) => module.up(context),
    down: ({ context }) => module.down(context),
  })),
  context: sequelize.getQueryInterface(),
  storage: new SequelizeStorage({ sequelize, tableName: 'schema_migrations' }),
  logger: undefined,
});

export const pendingMigrations = async () => (await migrator.pending()).map((m) => m.name);
