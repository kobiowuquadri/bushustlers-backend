import type { Express } from "express"
import { config } from "../config/config.js"
import { ensureCsrfCookie } from "../middlewares/csrf.js"
import { authRouter } from "./auth/index.js"
import { businessRouter, customersRouter, linksRouter, ordersRouter, overviewRouter, settlementsRouter, transactionsRouter } from "./merchant/index.js"
import { checkoutRouter } from "./payments/index.js"
import { devMailboxController, publicConfigController } from "../controllers/systemController.js"

const baseRoute = '/api/v1'

// Webhooks are mounted separately in app.ts because they need the raw request body.
const router = (app: Express) => {
  app.use(baseRoute, ensureCsrfCookie)
  app.get(`${baseRoute}/public/config`, publicConfigController)
  app.use(`${baseRoute}/auth`, authRouter)
  app.use(`${baseRoute}/business`, businessRouter)
  app.use(`${baseRoute}/overview`, overviewRouter)
  app.use(`${baseRoute}/customers`, customersRouter)
  app.use(`${baseRoute}/orders`, ordersRouter)
  app.use(`${baseRoute}/links`, linksRouter)
  app.use(`${baseRoute}/transactions`, transactionsRouter)
  app.use(`${baseRoute}/settlements`, settlementsRouter)
  app.use(`${baseRoute}/checkout`, checkoutRouter)
  if (config.email.devMailbox) {
    app.get(`${baseRoute}/dev/mailbox`, devMailboxController)
  }
}

export default router
