import { config, configWarnings } from './config/config.js'
import app from './app.js'
import sequelize, { connectToDB } from './database/db.js'
import { migrator, pendingMigrations } from './database/migrator.js'
import { getPaymentProvider } from './modules/payments/index.js'
import { startReconciler, stopReconciler } from './services/payments/reconcilerJob.js'
import { startEmailWorker, stopEmailWorker } from './modules/notifications/mailer.js'
import { describeError, logger } from './utils/logger.js'

const start = async () => {
    for (const warning of configWarnings) logger.warn(warning)

    await connectToDB()
    logger.info('Connected to the database')

    // Never start on an out-of-date schema. Migrations are additive and run explicitly
    // (npm run db:migrate), or at startup when DB_MIGRATE_ON_START=true.
    const pending = await pendingMigrations()
    if (pending.length) {
        if (!config.database.migrateOnStart) {
            logger.error('The database has pending migrations. Run `npm run db:migrate` or set DB_MIGRATE_ON_START=true.', { pending })
            process.exit(1)
        }
        await migrator.up()
        logger.info('Applied database migrations', { applied: pending })
    }

    const provider = getPaymentProvider()
    if (provider.mode === 'demo') {
        logger.warn('DEMO PAYMENTS MODE: checkout shows clearly labelled demo instructions. No real money can move.')
    } else {
        logger.info('Payments provider ready', { provider: provider.name, mode: provider.mode })
    }

    const server = app.listen(config.server.port, () => {
        logger.info(`Server running on port ${config.server.port}`, { appEnv: config.app.env })
    })
    startReconciler()
    startEmailWorker()

    // Let in-flight requests finish and close DB connections when the host stops the app (e.g. on redeploy)
    const shutdown = (signal: string) => {
        logger.info(`${signal} received, shutting down...`)
        stopReconciler()
        stopEmailWorker()
        server.close(async () => {
            await sequelize.close()
            process.exit(0)
        })
        setTimeout(() => process.exit(1), 10_000).unref()
    }

    process.on('SIGTERM', shutdown)
    process.on('SIGINT', shutdown)
}

start().catch((error) => {
    logger.error('Failed to start server', describeError(error))
    process.exit(1)
})
