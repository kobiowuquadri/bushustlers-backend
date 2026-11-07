import type { Request, Response } from 'express';
import { asyncHandler, sendResponse } from '../../utils/index.js';
import { createBusinessService, getBusinessService, updateBusinessService } from '../../services/business/businessService.js';
import { getCustomerService, listCustomersService, updateCustomerService } from '../../services/commerce/customerService.js';
import { cancelOrderService, createOrderService, getOrderService, listOrdersService, updateFulfilmentService, updateOrderService, type OrderView } from '../../services/commerce/orderService.js';
import { createPaymentLinkService, disablePaymentLinkService, listPaymentLinksService } from '../../services/commerce/paymentLinkService.js';
import { getTransactionService, listTransactionsService, refreshTransactionService, resolveReviewService, simulatePaymentService } from '../../services/payments/transactionService.js';
import { listSettlementsService, simulateSettlementService } from '../../services/payments/settlementService.js';
import { getOverviewService, type OverviewPeriod } from '../../services/overviewService.js';
import { buildReceipt } from '../../services/payments/checkoutService.js';
import { findOwnedOrder } from '../../services/commerce/orderService.js';
import { appError, messageHandler } from '../../utils/index.js';
import { NOT_FOUND, SUCCESS } from '../../constants/statusCode.js';
import { Order, OrderItem } from '../../schemas/index.js';

// Thin controllers: every handler runs after verify + requireBusiness, so req.user and req.business are set
// and every service call is scoped to the signed-in merchant's business.
type Q = Record<string, string | undefined>;

// ---- Business & onboarding -------------------------------------------------------------------
export const createBusinessController = asyncHandler(async (req: Request, res: Response) => {
  sendResponse(res, await createBusinessService(req.user!.id, req.body, req.id));
});
export const getBusinessController = asyncHandler(async (req: Request, res: Response) => {
  sendResponse(res, await getBusinessService(req.business!));
});
export const updateBusinessController = asyncHandler(async (req: Request, res: Response) => {
  sendResponse(res, await updateBusinessService(req.business!, req.body, req.user!.id, req.id));
});

// ---- Overview --------------------------------------------------------------------------------
export const overviewController = asyncHandler(async (req: Request, res: Response) => {
  sendResponse(res, await getOverviewService(req.business!, ((req.query as Q).period as OverviewPeriod) || '30d'));
});

// ---- Customers -------------------------------------------------------------------------------
export const listCustomersController = asyncHandler(async (req: Request, res: Response) => {
  sendResponse(res, await listCustomersService(req.business!, req.query as Q));
});
export const getCustomerController = asyncHandler(async (req: Request<{ customerId: string }>, res: Response) => {
  sendResponse(res, await getCustomerService(req.business!, req.params.customerId));
});
export const updateCustomerController = asyncHandler(async (req: Request<{ customerId: string }>, res: Response) => {
  sendResponse(res, await updateCustomerService(req.business!, req.params.customerId, req.body, req.user!.id, req.id));
});

// ---- Orders ----------------------------------------------------------------------------------
export const listOrdersController = asyncHandler(async (req: Request, res: Response) => {
  const query = req.query as Q;
  sendResponse(res, await listOrdersService(req.business!, { ...query, view: query.view as OrderView | undefined }));
});
export const createOrderController = asyncHandler(async (req: Request, res: Response) => {
  sendResponse(res, await createOrderService(req.business!, req.body, req.user!.id, req.id));
});
export const getOrderController = asyncHandler(async (req: Request<{ orderId: string }>, res: Response) => {
  sendResponse(res, await getOrderService(req.business!, req.params.orderId));
});
export const updateOrderController = asyncHandler(async (req: Request<{ orderId: string }>, res: Response) => {
  sendResponse(res, await updateOrderService(req.business!, req.params.orderId, req.body, req.user!.id, req.id));
});
export const cancelOrderController = asyncHandler(async (req: Request<{ orderId: string }>, res: Response) => {
  sendResponse(res, await cancelOrderService(req.business!, req.params.orderId, req.user!.id, req.id));
});
export const fulfilmentController = asyncHandler(async (req: Request<{ orderId: string }>, res: Response) => {
  sendResponse(res, await updateFulfilmentService(req.business!, req.params.orderId, req.body, req.user!.id, req.id));
});
export const orderReceiptController = asyncHandler(async (req: Request<{ orderId: string }>, res: Response) => {
  const owned = await findOwnedOrder(req.business!.id, req.params.orderId);
  const order = await Order.findByPk(owned.id, { include: [{ model: OrderItem, as: 'items' }], order: [[{ model: OrderItem, as: 'items' }, 'position', 'ASC']] });
  if (!order || order.paymentStatus !== 'paid') throw appError(NOT_FOUND, 'receipt_unavailable', 'A receipt is available once the payment is confirmed.');
  sendResponse(res, messageHandler('Receipt retrieved', true, SUCCESS, { receipt: await buildReceipt(order) }));
});

// ---- Payment links ---------------------------------------------------------------------------
export const createLinkController = asyncHandler(async (req: Request<{ orderId: string }>, res: Response) => {
  sendResponse(res, await createPaymentLinkService(req.business!, req.params.orderId, req.body, req.user!.id, req.id));
});
export const listLinksController = asyncHandler(async (req: Request, res: Response) => {
  sendResponse(res, await listPaymentLinksService(req.business!, req.query as Q));
});
export const disableLinkController = asyncHandler(async (req: Request<{ linkId: string }>, res: Response) => {
  sendResponse(res, await disablePaymentLinkService(req.business!, req.params.linkId, req.user!.id, req.id));
});

// ---- Transactions ----------------------------------------------------------------------------
export const listTransactionsController = asyncHandler(async (req: Request, res: Response) => {
  sendResponse(res, await listTransactionsService(req.business!, req.query as Q));
});
export const getTransactionController = asyncHandler(async (req: Request<{ transactionId: string }>, res: Response) => {
  sendResponse(res, await getTransactionService(req.business!, req.params.transactionId));
});
export const refreshTransactionController = asyncHandler(async (req: Request<{ transactionId: string }>, res: Response) => {
  sendResponse(res, await refreshTransactionService(req.business!, req.params.transactionId, req.id));
});
export const resolveReviewController = asyncHandler(async (req: Request<{ transactionId: string }>, res: Response) => {
  sendResponse(res, await resolveReviewService(req.business!, req.params.transactionId, req.body, req.user!.id, req.id));
});
export const simulatePaymentController = asyncHandler(async (req: Request<{ transactionId: string }>, res: Response) => {
  sendResponse(res, await simulatePaymentService(req.business!, req.params.transactionId, req.body.outcome, req.id));
});

// ---- Settlements -----------------------------------------------------------------------------
export const listSettlementsController = asyncHandler(async (req: Request, res: Response) => {
  sendResponse(res, await listSettlementsService(req.business!, req.query as Q));
});
export const simulateSettlementController = asyncHandler(async (req: Request<{ settlementId: string }>, res: Response) => {
  sendResponse(res, await simulateSettlementService(req.business!, req.params.settlementId, req.body.outcome, req.user!.id, req.id));
});
