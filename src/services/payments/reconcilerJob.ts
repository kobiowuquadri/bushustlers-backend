import { Op } from 'sequelize';
import { config } from '../../config/config.js';
import { PaymentAttempt, PaymentLink, ProviderEvent } from '../../schemas/index.js';
import { LATE_FUNDS_WATCH_HOURS } from '../../constants/payments.js';
import { describeError, logger } from '../../utils/logger.js';
import { fetchAndReconcile } from './reconciliationService.js';
import { MAX_EVENT_ATTEMPTS, processProviderEvent } from './webhookService.js';
import { expireAttemptLocally, expirePaymentLink } from './expiryService.js';

const BATCH = 20;
const ACTIVE_CHECK_MS = 60_000;
const LATE_WATCH_CHECK_MS = 10 * 60_000;

let timer: NodeJS.Timeout | null = null;
let running = false;

// One reconciliation pass. Covers missed or failed webhooks, stalled setups, expiry, and late funds.
// Every step is idempotent: re-running it (or running it on two instances) cannot double-apply a payment.
export const runReconciliationCycle = async () => {
  if (running) return;
  running = true;
  const now = Date.now();
  try {
    // 1. Stored events that have not been processed yet (e.g. the process restarted after acknowledging)
    const events = await ProviderEvent.findAll({
      where: { status: { [Op.in]: ['received', 'failed'] }, processingAttempts: { [Op.lt]: MAX_EVENT_ATTEMPTS }, receivedAt: { [Op.lt]: new Date(now - 5_000) } },
      order: [['receivedAt', 'ASC']],
      limit: BATCH,
    });
    for (const event of events) await processProviderEvent(event.id);

    // 2. Setups that never got provider instructions (crash or timeout between the two phases)
    await PaymentAttempt.update(
      { status: 'failed', failedAt: new Date(), failureReason: 'Payment setup did not complete' },
      { where: { status: 'creating', providerReference: null, createdAt: { [Op.lt]: new Date(now - 5 * 60_000) } } },
    );

    // 3. Active attempts: ask the provider directly in case a notification was missed
    const due = await PaymentAttempt.findAll({
      where: {
        status: { [Op.in]: ['awaiting_payment', 'processing'] },
        providerReference: { [Op.ne]: null },
        [Op.or]: [{ lastCheckedAt: null }, { lastCheckedAt: { [Op.lt]: new Date(now - ACTIVE_CHECK_MS) } }],
      },
      order: [['lastCheckedAt', 'ASC']],
      limit: BATCH,
    });
    // 4. Closed attempts are still watched for late funds
    const watched = await PaymentAttempt.findAll({
      where: {
        status: { [Op.in]: ['expired', 'cancelled'] },
        providerReference: { [Op.ne]: null },
        createdAt: { [Op.gt]: new Date(now - (LATE_FUNDS_WATCH_HOURS + 24) * 60 * 60_000) },
        [Op.or]: [{ lastCheckedAt: null }, { lastCheckedAt: { [Op.lt]: new Date(now - LATE_WATCH_CHECK_MS) } }],
      },
      order: [['lastCheckedAt', 'ASC']],
      limit: BATCH,
    });
    for (const attempt of [...due, ...watched]) {
      try {
        await fetchAndReconcile(attempt.id, { source: 'reconciler' });
      } catch (error) {
        logger.warn('Reconciler could not check a payment', { attempt: attempt.publicId, ...describeError(error) });
        await attempt.update({ lastCheckedAt: new Date() }).catch(() => undefined);
      }
    }

    // 5. Instructions past their validity window
    const lapsed = await PaymentAttempt.findAll({ where: { status: 'awaiting_payment', expiresAt: { [Op.lt]: new Date(now - 60_000) } }, limit: BATCH });
    for (const attempt of lapsed) await expireAttemptLocally(attempt.id);

    // 6. Links past their expiry
    const links = await PaymentLink.findAll({ where: { status: 'active', expiresAt: { [Op.lt]: new Date(now) } }, limit: 50 });
    for (const link of links) await expirePaymentLink(link.id);
  } catch (error) {
    logger.error('Reconciliation cycle failed', describeError(error));
  } finally {
    running = false;
  }
};

export const startReconciler = () => {
  const seconds = config.payments.reconcileIntervalSeconds;
  if (!seconds || timer) return;
  timer = setInterval(() => void runReconciliationCycle(), seconds * 1000);
  timer.unref();
  logger.info('Payment reconciler started', { intervalSeconds: seconds });
};

export const stopReconciler = () => {
  if (timer) clearInterval(timer);
  timer = null;
};
