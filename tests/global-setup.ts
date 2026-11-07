import mysql from 'mysql2/promise';

const LOCAL_HOSTS = ['localhost', '127.0.0.1', '::1'];

// Resets the disposable test database once per run, then applies the real migrations.
// Hard guards: only a localhost database whose name ends in _test is ever dropped.
export default async function setup() {
  const host = process.env.DB_HOST || '';
  const database = process.env.DB_NAME || '';
  if (!LOCAL_HOSTS.includes(host) || !database.endsWith('_test')) {
    throw new Error(`Refusing to reset "${database}" on "${host}": tests only run against a localhost *_test database.`);
  }
  const connection = await mysql.createConnection({
    host,
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    multipleStatements: true,
  });
  await connection.query(`DROP DATABASE IF EXISTS \`${database}\`; CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`);
  await connection.end();

  const { migrator } = await import('../src/database/migrator.js');
  const { default: sequelize } = await import('../src/database/db.js');
  await migrator.up();
  await sequelize.close();
}
