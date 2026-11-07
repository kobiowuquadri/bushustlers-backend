import { Op, QueryTypes } from 'sequelize';
import sequelize from '../database/db.js';
import { Order, PaymentAttempt, type Business } from '../schemas/index.js';
import { messageHandler } from '../utils/index.js';
import { SUCCESS } from '../constants/statusCode.js';
import { serializeAttempt } from './serializers.js';
import { environmentStatus } from './business/businessService.js';

export const OVERVIEW_PERIODS = { '7d': 7, '30d': 30, '90d': 90 } as const;
export type OverviewPeriod = keyof typeof OVERVIEW_PERIODS;

// Every figure comes from reconciled database records. There is deliberately no "available balance":
// a confirmed payment is not money in the merchant's bank until it is settled.
export const getOverviewService = async (business: Business, period: OverviewPeriod = '30d') => {
  const to = new Date();
  const from = new Date(to.getTime() - OVERVIEW_PERIODS[period] * 24 * 60 * 60 * 1000);
  const replacements = { businessId: business.id, from };

  const [volume, awaiting, toFulfil, review, pendingSettlement, recent] = await Promise.all([
    sequelize.query<{ count: string; volumeMinor: string | null }>(
      `SELECT COUNT(*) AS count, SUM(COALESCE(receivedAmountMinor, expectedAmountMinor)) AS volumeMinor
         FROM payment_attempts WHERE businessId = :businessId AND status = 'confirmed' AND confirmedAt >= :from`,
      { replacements, type: QueryTypes.SELECT },
    ),
    sequelize.query<{ count: string; valueMinor: string | null }>(
      `SELECT COUNT(*) AS count, SUM(totalMinor) AS valueMinor FROM orders
        WHERE businessId = :businessId AND status = 'open' AND paymentStatus IN ('unpaid','processing')`,
      { replacements, type: QueryTypes.SELECT },
    ),
    Order.count({ where: { businessId: business.id, paymentStatus: 'paid', fulfilmentStatus: 'unfulfilled' } }),
    Order.count({ where: { businessId: business.id, [Op.or]: [{ paymentStatus: 'needs_review' }, { reviewRequired: true }] } }),
    sequelize.query<{ count: string; netMinor: string | null }>(
      `SELECT COUNT(*) AS count, SUM(netMinor) AS netMinor FROM settlements WHERE businessId = :businessId AND status = 'pending'`,
      { replacements, type: QueryTypes.SELECT },
    ),
    PaymentAttempt.findAll({
      where: { businessId: business.id, status: { [Op.ne]: 'creating' } },
      include: [{ model: Order, as: 'order', attributes: ['id', 'publicId', 'reference'] }],
      order: [['updatedAt', 'DESC']],
      limit: 6,
    }),
  ]);

  return messageHandler('Overview retrieved', true, SUCCESS, {
    period,
    from,
    to,
    confirmedVolumeMinor: String(volume[0]?.volumeMinor ?? '0'),
    confirmedPaymentCount: Number(volume[0]?.count ?? 0),
    awaitingPayment: { count: Number(awaiting[0]?.count ?? 0), valueMinor: String(awaiting[0]?.valueMinor ?? '0') },
    paidAwaitingFulfilment: toFulfil,
    needsReview: review,
    pendingSettlement: { count: Number(pendingSettlement[0]?.count ?? 0), netMinor: String(pendingSettlement[0]?.netMinor ?? '0') },
    recentTransactions: recent.map((attempt) => serializeAttempt(attempt, { order: (attempt as PaymentAttempt & { order?: Order }).order })),
    environment: environmentStatus(),
  });
};
