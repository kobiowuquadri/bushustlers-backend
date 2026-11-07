import { Sequelize } from 'sequelize';
import { config } from "../config/config.js";

const sequelize = new Sequelize(
  config.database.name,
  config.database.user,
  config.database.password,
  {
    host: config.database.host,
    port: config.database.port,
    dialect: 'mysql',
    logging: false,
    // Store and read every DATETIME as UTC
    timezone: '+00:00',
    dialectOptions: {
      // BIGINT/DECIMAL values come back as strings so money is never rounded through a JS float
      supportBigNumbers: true,
      bigNumberStrings: true,
      decimalNumbers: false,
      charset: 'utf8mb4',
      ...(config.database.ssl
        ? { ssl: { rejectUnauthorized: config.database.sslRejectUnauthorized, minVersion: 'TLSv1.2' } }
        : {}),
    },
    define: {
      charset: 'utf8mb4',
      collate: 'utf8mb4_unicode_ci',
    },
    pool: {
      max: config.database.poolMax,
      min: 0,
      acquire: 30000,
      idle: 10000
    }
  }
)

// Retries briefly (hosted MySQL can refuse connections for a few seconds during restarts), then throws so
// the server never starts without a database. Schema changes are applied by migrations, never by sync().
export const connectToDB = async (attempts = 6) => {
  for (let attempt = 1; ; attempt++) {
    try {
      await sequelize.authenticate()
      return
    } catch (error) {
      if (attempt >= attempts) throw error
      const waitMs = Math.min(2000 * attempt, 10000)
      console.warn(`[warn] Database not reachable (attempt ${attempt}/${attempts}); retrying in ${waitMs / 1000}s`)
      await new Promise((resolve) => setTimeout(resolve, waitMs))
    }
  }
}

export default sequelize
