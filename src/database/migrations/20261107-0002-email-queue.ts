import type { QueryInterface } from 'sequelize';

// Turns email_outbox into a delivery queue: emails are queued by requests and sent by a background worker
// with retries. Additive: existing status values stay valid, new columns have defaults.

const columnExists = async (qi: QueryInterface, table: string, column: string) => {
  const [rows] = await qi.sequelize.query(
    'SELECT COUNT(*) AS n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
    { replacements: [table, column] },
  );
  return Number((rows as Array<{ n: string | number }>)[0]?.n) > 0;
};

const indexExists = async (qi: QueryInterface, table: string, index: string) => {
  const [rows] = await qi.sequelize.query(
    'SELECT COUNT(*) AS n FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?',
    { replacements: [table, index] },
  );
  return Number((rows as Array<{ n: string | number }>)[0]?.n) > 0;
};

export const up = async (qi: QueryInterface) => {
  await qi.sequelize.query(
    "ALTER TABLE `email_outbox` MODIFY `status` ENUM('queued','sending','sent','failed','captured') NOT NULL DEFAULT 'queued'",
  );
  if (!(await columnExists(qi, 'email_outbox', 'attempts'))) {
    await qi.sequelize.query('ALTER TABLE `email_outbox` ADD COLUMN `attempts` INT NOT NULL DEFAULT 0');
  }
  if (!(await columnExists(qi, 'email_outbox', 'nextAttemptAt'))) {
    await qi.sequelize.query('ALTER TABLE `email_outbox` ADD COLUMN `nextAttemptAt` DATETIME(3) NULL');
  }
  if (!(await columnExists(qi, 'email_outbox', 'sentAt'))) {
    await qi.sequelize.query('ALTER TABLE `email_outbox` ADD COLUMN `sentAt` DATETIME(3) NULL');
  }
  if (!(await indexExists(qi, 'email_outbox', 'email_outbox_queue_idx'))) {
    await qi.sequelize.query('CREATE INDEX `email_outbox_queue_idx` ON `email_outbox` (`status`, `nextAttemptAt`)');
  }
};

// Local development only (the migrate CLI refuses rollbacks elsewhere)
export const down = async (qi: QueryInterface) => {
  if (await indexExists(qi, 'email_outbox', 'email_outbox_queue_idx')) {
    await qi.sequelize.query('DROP INDEX `email_outbox_queue_idx` ON `email_outbox`');
  }
  for (const column of ['sentAt', 'nextAttemptAt', 'attempts']) {
    if (await columnExists(qi, 'email_outbox', column)) await qi.sequelize.query(`ALTER TABLE \`email_outbox\` DROP COLUMN \`${column}\``);
  }
  await qi.sequelize.query("UPDATE `email_outbox` SET `status` = 'failed' WHERE `status` IN ('queued','sending')");
  await qi.sequelize.query("ALTER TABLE `email_outbox` MODIFY `status` ENUM('sent','failed','captured') NOT NULL");
};
