// Usage: npm run db:migrate            apply pending migrations (additive only)
//        npm run db:migrate -- status  list applied and pending migrations
//        npm run db:migrate -- down    undo the last migration (local development and test databases only)
import { config } from '../config/config.js';
import sequelize from '../database/db.js';
import { migrator } from '../database/migrator.js';

const isLocalHost = (host: string) => ['localhost', '127.0.0.1', '::1'].includes(host);

const main = async () => {
  const command = process.argv[2] || 'up';
  await sequelize.authenticate();
  console.log(`Database: ${config.database.name} on ${isLocalHost(config.database.host) ? config.database.host : 'remote host'} (APP_ENV=${config.app.env})`);

  if (command === 'status') {
    const executed = (await migrator.executed()).map((m) => m.name);
    const pending = (await migrator.pending()).map((m) => m.name);
    console.log('Applied:', executed.length ? executed.join(', ') : '(none)');
    console.log('Pending:', pending.length ? pending.join(', ') : '(none)');
  } else if (command === 'up') {
    const applied = await migrator.up();
    console.log(applied.length ? `Applied: ${applied.map((m) => m.name).join(', ')}` : 'Nothing to apply; the schema is up to date.');
  } else if (command === 'down') {
    // Rolling back drops tables. Refuse anywhere except a local development or test database.
    if (!config.app.isLocal || !isLocalHost(config.database.host)) {
      throw new Error('Refusing to roll back: only allowed with APP_ENV=development/test on a localhost database.');
    }
    const reverted = await migrator.down();
    console.log(reverted.length ? `Reverted: ${reverted.map((m) => m.name).join(', ')}` : 'Nothing to revert.');
  } else {
    throw new Error(`Unknown command "${command}". Use up, status or down.`);
  }
};

main()
  .then(() => sequelize.close())
  .catch(async (error) => {
    console.error(error instanceof Error ? error.message : error);
    await sequelize.close().catch(() => undefined);
    process.exit(1);
  });
