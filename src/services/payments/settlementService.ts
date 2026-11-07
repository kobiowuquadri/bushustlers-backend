import { Op, QueryTypes, type WhereOptions } from 'sequelize';
import sequelize from '../../database/db.js';
import { config } from '../../config/config.js';
import { Order, PaymentAttempt, Settlement, type Business } from '../../schemas/index.js';
import { appError, getPagination, messageHandler, paginate, randomBase62 } from '../../utils/index.js';
import { CONFLICT, FORBIDDEN, NOT_FOUND, SUCCESS } from '../../constants/statusCode.js';
import { recordAudit } from '../audit/auditService.js';
import { serializeSettlement } from '../serializers.js';
import { getPaymentProvider } from '../../modules/payments/index.js';

// Settlement payouts are not integrated: no provider payout API is called and no balance is invented.
export const settlementIntegrationStatus = () => {
  const provider = getPaymentProvider();
  return {
    payoutsAutomated: false,
    providerMode: provider.mode,
    message:
      provider.mode === 'demo'
        ? 'Demo mode: settlements are simulated records. No money moves.'
        : 'Payouts to merchant bank accounts are not automated in this release. A settlement stays pending until a payout is recorded.',
  };
};

export const listSettlementsService = async (business: Business, query: { status?: string; page?: unknown; limit?: unknown }) => {
  const { page, limit, offset } = getPagination(query, 20, 100);
  const where: WhereOptions = { businessId: business.id };
  if (query.status && ['pending', 'settled', 'failed'].includes(query.status)) Object.assign(where, { status: query.status });
  const result = await Settlement.findAndCountAll({ where, order: [['createdAt', 'DESC'], ['id', 'DESC']], limit, offset });
  const [orders, attempts, totals] = await Promise.all([
    result.rows.length ? Order.findAll({ where: { id: { [Op.in]: result.rows.map((s) => s.orderId) } }, attributes: ['id', 'publicId', 'reference'] }) : [],
    result.rows.length ? PaymentAttempt.findAll({ where: { id: { [Op.in]: result.rows.map((s) => s.paymentAttemptId) } } }) : [],
    sequelize.query<{ status: string; count: string; grossMinor: string; netMinor: string; platformFeeMinor: string }>(
      `SELECT status, COUNT(*) AS count, SUM(grossMinor) AS grossMinor, SUM(netMinor) AS netMinor, SUM(platformFeeMinor) AS platformFeeMinor
         FROM settlements WHERE businessId = :businessId GROUP BY status`,
      { replacements: { businessId: business.id }, type: QueryTypes.SELECT },
    ),
  ]);
  const summary = Object.fromEntries(
    ['pending', 'settled', 'failed'].map((status) => {
      const row = totals.find((t) => t.status === status);
      return [status, { count: Number(row?.count ?? 0), grossMinor: String(row?.grossMinor ?? '0'), netMinor: String(row?.netMinor ?? '0'), platformFeeMinor: String(row?.platformFeeMinor ?? '0') }];
    }),
  );
  const { pagination } = paginate(result, page, limit);
  return messageHandler('Settlements retrieved', true, SUCCESS, {
    items: result.rows.map((s) => serializeSettlement(s, { order: orders.find((o) => o.id === s.orderId), attempt: attempts.find((a) => a.id === s.paymentAttemptId) })),
    pagination,
    summary,
    integration: settlementIntegrationStatus(),
  });
};

// Demo mode only: moves a simulated settlement to settled/failed so the states can be demonstrated.
export const simulateSettlementService = async (business: Business, settlementPublicId: string, outcome: 'settled' | 'failed', userId: number, requestId?: string) => {
  if (!config.payments.demoToolsEnabled) throw appError(FORBIDDEN, 'demo_tools_disabled', 'Simulation is not available in this environment');
  const settlement = await Settlement.findOne({ where: { publicId: settlementPublicId, businessId: business.id } });
  if (!settlement) throw appError(NOT_FOUND, 'settlement_not_found', 'Settlement not found');
  if (!settlement.simulated) throw appError(CONFLICT, 'not_simulated', 'Only demo settlements can be simulated');
  if (settlement.status !== 'pending') throw appError(CONFLICT, 'settlement_closed', `This settlement is already ${settlement.status}`);
  await settlement.update(
    outcome === 'settled'
      ? { status: 'settled', settledAt: new Date(), payoutReference: `DEMO-PAYOUT-${randomBase62(8)}` }
      : { status: 'failed', failureReason: 'Simulated payout failure (demo)' },
  );
  await recordAudit({ businessId: business.id, orderId: settlement.orderId, entityType: 'settlement', entityId: settlement.id, action: `settlement.${outcome}`, actor: { type: 'user', id: userId }, fromStatus: 'pending', toStatus: outcome, metadata: { simulated: true }, requestId });
  return messageHandler(outcome === 'settled' ? 'Settlement marked settled (simulated)' : 'Settlement marked failed (simulated)', true, SUCCESS, { settlement: serializeSettlement(settlement) });
};
