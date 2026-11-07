import express from 'express';
import { validate } from '../../validations/index.js';
import { verify, requireBusiness } from '../../middlewares/auth.js';
import { requireCsrf } from '../../middlewares/csrf.js';
import { providerRefreshLimiter } from '../../middlewares/rateLimiter.js';
import * as c from '../../controllers/merchant/merchantController.js';
import * as v from '../../validations/merchantValidations.js';

// Business onboarding: signed in, but no business yet
export const businessRouter = express.Router();
businessRouter.use(requireCsrf, verify);
businessRouter.post('/', validate(v.createBusinessValidation), c.createBusinessController);
businessRouter.get('/', requireBusiness, c.getBusinessController);
businessRouter.patch('/', requireBusiness, validate(v.updateBusinessValidation), c.updateBusinessController);

// Everything else requires a business; every query is scoped to req.business
const merchant = () => {
  const router = express.Router();
  router.use(requireCsrf, verify, requireBusiness);
  return router;
};

export const overviewRouter = merchant();
overviewRouter.get('/', validate(v.overviewValidation), c.overviewController);

export const customersRouter = merchant();
customersRouter.get('/', validate(v.listCustomersValidation), c.listCustomersController);
customersRouter.get('/:customerId', validate(v.customerIdValidation), c.getCustomerController);
customersRouter.patch('/:customerId', validate(v.updateCustomerValidation), c.updateCustomerController);

export const ordersRouter = merchant();
ordersRouter.get('/', validate(v.listOrdersValidation), c.listOrdersController);
ordersRouter.post('/', validate(v.orderBodyValidation), c.createOrderController);
ordersRouter.get('/:orderId', validate(v.orderIdValidation), c.getOrderController);
ordersRouter.put('/:orderId', validate(v.updateOrderValidation), c.updateOrderController);
ordersRouter.post('/:orderId/cancel', validate(v.orderIdValidation), c.cancelOrderController);
ordersRouter.post('/:orderId/fulfilment', validate(v.fulfilmentValidation), c.fulfilmentController);
ordersRouter.post('/:orderId/links', validate(v.createLinkValidation), c.createLinkController);
ordersRouter.get('/:orderId/receipt', validate(v.orderIdValidation), c.orderReceiptController);

export const linksRouter = merchant();
linksRouter.get('/', validate(v.listLinksValidation), c.listLinksController);
linksRouter.post('/:linkId/disable', validate(v.linkIdValidation), c.disableLinkController);

export const transactionsRouter = merchant();
transactionsRouter.get('/', validate(v.listTransactionsValidation), c.listTransactionsController);
transactionsRouter.get('/:transactionId', validate(v.transactionIdValidation), c.getTransactionController);
transactionsRouter.post('/:transactionId/refresh', providerRefreshLimiter, validate(v.transactionIdValidation), c.refreshTransactionController);
transactionsRouter.post('/:transactionId/resolve', validate(v.resolveReviewValidation), c.resolveReviewController);
transactionsRouter.post('/:transactionId/simulate', validate(v.simulatePaymentValidation), c.simulatePaymentController);

export const settlementsRouter = merchant();
settlementsRouter.get('/', validate(v.listSettlementsValidation), c.listSettlementsController);
settlementsRouter.post('/:settlementId/simulate', validate(v.simulateSettlementValidation), c.simulateSettlementController);
