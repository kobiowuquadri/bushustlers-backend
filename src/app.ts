import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import cookieParser from 'cookie-parser'
import { config } from './config/config.js'
import sequelize from './database/db.js'
import router from './routes/index.js'
import { webhookRouter } from './routes/payments/index.js'
import { notFound, errorHandler } from './middlewares/errorHandler.js'
import { requestContext } from './middlewares/requestContext.js'
import { messageHandler } from './utils/index.js'
import { SUCCESS, SERVICE_UNAVAILABLE } from './constants/statusCode.js'
import { getPaymentProvider } from './modules/payments/index.js'

const app = express()

app.set('trust proxy', config.server.trustProxy)
app.disable('x-powered-by')

//middleware
app.use(requestContext)
app.use(helmet())
// Only the configured frontend origins may call the API from a browser, with cookies
app.use(cors({
    origin: (origin, callback) => callback(null, !origin || config.server.corsOrigins.includes(origin.replace(/\/+$/, ''))),
    credentials: true,
    allowedHeaders: ['Content-Type', 'X-CSRF-Token', 'Idempotency-Key', 'X-Request-Id'],
    exposedHeaders: ['X-Request-Id'],
}))

// Webhook signatures are computed over the exact bytes received, so these routes get the raw body
// and must be registered before the JSON parser.
app.use('/api/v1/webhooks', express.raw({ type: '*/*', limit: '256kb' }), webhookRouter)

app.use(express.json({ limit: '100kb' }))
app.use(express.urlencoded({ extended: false, limit: '100kb' }))
app.use(cookieParser())

app.get('/', (req, res) => {
    res.json({suceess: true, message: "Backend connected Successfully to Bushustlers"})
})

// For uptime monitors and the hosting platform's health check. Reports no configuration or secrets.
app.get('/health', async (req, res) => {
    try {
        await sequelize.authenticate()
        res.status(SUCCESS).json(messageHandler('OK', true, SUCCESS, { database: 'up', paymentsMode: getPaymentProvider().mode, uptime: Math.round(process.uptime()) }))
    } catch {
        res.status(SERVICE_UNAVAILABLE).json(messageHandler('Database unreachable', false, SERVICE_UNAVAILABLE, { database: 'down' }))
    }
})

//routes
router(app)

// Must come after all routes
app.use(notFound)
app.use(errorHandler)

export default app
