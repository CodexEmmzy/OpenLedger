import { createHash, randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import type { Pool } from 'pg';
import {
  initializePaystackPayment,
  verifyPaystackTransaction,
  type PaystackConfig,
  type PaystackVerifiedTransaction,
  type WorkerEnv,
} from '@openledger/shared';

interface OutboxEvent {
  id: string;
  event_type: string;
  payload: Record<string, unknown>;
  attempts: number;
}

interface PaymentRow {
  id: string;
  reference: string;
  account_id: string;
  amount_minor: string;
  currency: string;
  customer_email: string;
  status: string;
}

interface ProviderEventRow {
  id: string;
  event_type: string;
  reference: string;
  amount_minor: string;
  currency: string;
  status: string;
}

const MAX_ATTEMPTS = 8;
const CLAIM_TIMEOUT_SECONDS = 120;
type PaystackVerifier = (
  config: PaystackConfig,
  reference: string,
) => Promise<PaystackVerifiedTransaction>;

export async function processOutboxBatch(
  pool: Pool,
  env: WorkerEnv,
  logger: Logger,
  workerId: string = randomUUID(),
  batchLimit = 10,
  paystackVerifier: PaystackVerifier = verifyPaystackTransaction,
): Promise<number> {
  let processed = 0;
  for (let index = 0; index < batchLimit; index += 1) {
    const event = await claimEvent(pool, workerId);
    if (!event) {
      break;
    }
    try {
      if (event.event_type === 'provider.paystack.initialize') {
        await initializePayment(pool, env, event);
      } else if (event.event_type === 'provider.paystack.event') {
        await reconcilePaystackEvent(pool, env, event, logger, paystackVerifier);
      } else {
        throw new PermanentJobError(`unsupported outbox event type: ${event.event_type}`);
      }
      await completeEvent(pool, event.id, workerId);
      processed += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 500) : 'unknown job error';
      const permanent = error instanceof PermanentJobError;
      await retryOrDeadLetter(pool, event, workerId, message, permanent);
      logger.error(
        {
          outboxEventId: event.id,
          eventType: event.event_type,
          attempt: event.attempts,
          permanent,
        },
        'outbox event processing failed',
      );
    }
  }
  return processed;
}

export async function checkLedgerInvariants(pool: Pool): Promise<{
  mismatchedAccounts: number;
  unbalancedTransactions: number;
}> {
  const result = await pool.query<{
    mismatched_accounts: string;
    unbalanced_transactions: string;
  }>(`
    WITH balance_mismatches AS (
      SELECT a.id
      FROM accounts a
      JOIN account_balances b ON b.account_id = a.id
      LEFT JOIN entries e ON e.account_id = a.id
      LEFT JOIN transactions t ON t.id = e.transaction_id AND t.status = 'posted'
      WHERE e.id IS NULL OR t.id IS NOT NULL
      GROUP BY a.id, a.type, b.balance_minor
      HAVING b.balance_minor <> COALESCE(sum(
        CASE
          WHEN e.id IS NULL THEN 0
          WHEN (a.type IN ('asset', 'expense') AND e.direction = 'debit')
            OR (a.type IN ('liability', 'equity', 'income') AND e.direction = 'credit')
            THEN e.amount_minor
          ELSE -e.amount_minor
        END
      ), 0)
    ), unbalanced AS (
      SELECT t.id
      FROM transactions t
      LEFT JOIN entries e ON e.transaction_id = t.id
      WHERE t.status = 'posted'
      GROUP BY t.id
      HAVING count(e.id) < 2
        OR count(DISTINCT e.account_id) < 2
        OR COALESCE(sum(e.amount_minor) FILTER (WHERE e.direction = 'debit'), 0)
          <> COALESCE(sum(e.amount_minor) FILTER (WHERE e.direction = 'credit'), 0)
    )
    SELECT
      (SELECT count(*)::text FROM balance_mismatches) AS mismatched_accounts,
      (SELECT count(*)::text FROM unbalanced) AS unbalanced_transactions
  `);
  return {
    mismatchedAccounts: Number(result.rows[0]?.mismatched_accounts ?? '0'),
    unbalancedTransactions: Number(result.rows[0]?.unbalanced_transactions ?? '0'),
  };
}

async function claimEvent(pool: Pool, workerId: string): Promise<OutboxEvent | null> {
  const result = await pool.query<OutboxEvent>(
    `WITH next_event AS (
       SELECT id
       FROM outbox_events
       WHERE attempts < $2
         AND ((status = 'pending' AND available_at <= now())
           OR (status = 'processing' AND locked_at < now() - ($3 * interval '1 second')))
       ORDER BY id
       FOR UPDATE SKIP LOCKED
       LIMIT 1
     )
     UPDATE outbox_events event
     SET status = 'processing', attempts = event.attempts + 1,
         locked_at = now(), lock_owner = $1
     FROM next_event
     WHERE event.id = next_event.id
     RETURNING event.id::text, event.event_type, event.payload, event.attempts`,
    [workerId, MAX_ATTEMPTS, CLAIM_TIMEOUT_SECONDS],
  );
  return result.rows[0] ?? null;
}

async function initializePayment(pool: Pool, env: WorkerEnv, event: OutboxEvent): Promise<void> {
  if (!env.PAYSTACK_SECRET_KEY) {
    throw new Error('Paystack secret is not configured for the worker');
  }
  const reference = readPayloadString(event.payload, 'reference');
  const result = await pool.query<PaymentRow>(
    `SELECT id, reference, account_id, amount_minor::text, currency, customer_email, status
     FROM provider_payments WHERE reference = $1`,
    [reference],
  );
  const payment = result.rows[0];
  if (!payment) {
    throw new PermanentJobError('payment intent not found');
  }
  if (payment.status === 'initialized' || payment.status === 'succeeded') {
    return;
  }
  if (payment.status !== 'pending') {
    throw new PermanentJobError(`payment intent cannot initialize from state ${payment.status}`);
  }

  const initialized = await initializePaystackPayment(
    { secretKey: env.PAYSTACK_SECRET_KEY, baseUrl: env.PAYSTACK_BASE_URL },
    {
      email: payment.customer_email,
      amountMinor: BigInt(payment.amount_minor),
      currency: payment.currency,
      reference: payment.reference,
      accountId: payment.account_id,
    },
  );
  await pool.query(
    `UPDATE provider_payments
     SET status = 'initialized', authorization_url = $2, provider_reference = $3
     WHERE reference = $1 AND status = 'pending'`,
    [payment.reference, initialized.authorizationUrl, initialized.providerReference],
  );
}

async function reconcilePaystackEvent(
  pool: Pool,
  env: WorkerEnv,
  event: OutboxEvent,
  logger: Logger,
  paystackVerifier: PaystackVerifier,
): Promise<void> {
  const eventId = readPayloadString(event.payload, 'eventId');
  const candidate = await pool.query<ProviderEventRow>(
    `SELECT id::text, event_type, reference, amount_minor::text, currency, status
     FROM provider_events WHERE id = $1`,
    [eventId],
  );
  const candidateEvent = candidate.rows[0];
  if (!candidateEvent) {
    throw new PermanentJobError('provider event not found');
  }
  if (candidateEvent.status === 'reconciled' || candidateEvent.status === 'rejected') {
    return;
  }

  let verified: PaystackVerifiedTransaction | undefined;
  if (candidateEvent.event_type === 'charge.success') {
    if (!env.PAYSTACK_SECRET_KEY) {
      throw new Error('Paystack secret is not configured for transaction verification');
    }
    verified = await paystackVerifier(
      { secretKey: env.PAYSTACK_SECRET_KEY, baseUrl: env.PAYSTACK_BASE_URL },
      candidateEvent.reference,
    );
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const providerEventResult = await client.query<ProviderEventRow>(
      `SELECT id::text, event_type, reference, amount_minor::text, currency, status
       FROM provider_events WHERE id = $1 FOR UPDATE`,
      [eventId],
    );
    const providerEvent = providerEventResult.rows[0];
    if (!providerEvent) {
      throw new PermanentJobError('provider event not found');
    }
    if (providerEvent.status === 'reconciled' || providerEvent.status === 'rejected') {
      await client.query('COMMIT');
      return;
    }

    const paymentResult = await client.query<PaymentRow>(
      `SELECT id, reference, account_id, amount_minor::text, currency, customer_email, status
       FROM provider_payments WHERE reference = $1 FOR UPDATE`,
      [providerEvent.reference],
    );
    const payment = paymentResult.rows[0];
    if (
      providerEvent.event_type !== 'charge.success' ||
      !verified ||
      verified.reference !== providerEvent.reference ||
      verified.status !== 'success' ||
      verified.amountMinor.toString() !== providerEvent.amount_minor ||
      verified.currency !== providerEvent.currency ||
      !payment ||
      payment.amount_minor !== providerEvent.amount_minor ||
      payment.currency !== providerEvent.currency ||
      !['initialized', 'pending'].includes(payment.status)
    ) {
      if (payment && ['pending', 'initialized'].includes(payment.status)) {
        await client.query(
          `UPDATE provider_payments SET status = 'reconciliation_required' WHERE id = $1`,
          [payment.id],
        );
      }
      await client.query(
        `UPDATE provider_events SET status = 'rejected', processed_at = now() WHERE id = $1`,
        [providerEvent.id],
      );
      logger.error({ providerEventId: providerEvent.id }, 'Paystack event requires manual review');
      await client.query('COMMIT');
      return;
    }

    const clearing = await client.query<{ id: string }>(
      `SELECT id FROM accounts WHERE account_code = $1`,
      [`provider_clearing_${payment.currency}`],
    );
    const clearingAccount = clearing.rows[0];
    if (!clearingAccount) {
      throw new PermanentJobError('provider clearing account is missing');
    }

    const idempotencyKey = `paystack-deposit:${payment.reference}`;
    const requestHash = createHash('sha256')
      .update(`${payment.account_id}:${payment.amount_minor}:${payment.currency}`)
      .digest('hex');
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO transactions (idempotency_key, request_hash, type, currency)
       VALUES ($1, $2, 'deposit', $3)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING id`,
      [idempotencyKey, requestHash, payment.currency],
    );
    let transactionId = inserted.rows[0]?.id;
    if (!transactionId) {
      const existing = await client.query<{ id: string; request_hash: string; status: string }>(
        `SELECT id, request_hash, status FROM transactions
         WHERE idempotency_key = $1 FOR UPDATE`,
        [idempotencyKey],
      );
      const transaction = existing.rows[0];
      if (
        !transaction ||
        transaction.request_hash !== requestHash ||
        transaction.status !== 'posted'
      ) {
        throw new PermanentJobError(
          'existing Paystack deposit ledger entry conflicts with the payment',
        );
      }
      transactionId = transaction.id;
    } else {
      await client.query(
        `INSERT INTO entries (transaction_id, account_id, direction, amount_minor)
         VALUES ($1, $2, 'debit', $3), ($1, $4, 'credit', $3)`,
        [transactionId, clearingAccount.id, payment.amount_minor, payment.account_id],
      );
      await client.query(
        `UPDATE transactions SET status = 'posted', status_reason = 'Paystack charge.success verified'
         WHERE id = $1`,
        [transactionId],
      );
    }

    await client.query(
      `UPDATE provider_payments SET status = 'succeeded', provider_reference = $2 WHERE id = $1`,
      [payment.id, providerEvent.reference],
    );
    await client.query(
      `UPDATE provider_events SET status = 'reconciled', processed_at = now() WHERE id = $1`,
      [providerEvent.id],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function completeEvent(pool: Pool, eventId: string, workerId: string): Promise<void> {
  await pool.query(
    `UPDATE outbox_events
     SET status = 'completed', completed_at = now(), locked_at = NULL, lock_owner = NULL
     WHERE id = $1 AND status = 'processing' AND lock_owner = $2`,
    [eventId, workerId],
  );
}

async function retryOrDeadLetter(
  pool: Pool,
  event: OutboxEvent,
  workerId: string,
  message: string,
  permanent: boolean,
): Promise<void> {
  const dead = permanent || event.attempts >= MAX_ATTEMPTS;
  await pool.query(
    `UPDATE outbox_events
     SET status = $3::outbox_status,
         available_at = CASE WHEN $3 = 'pending'
           THEN now() + (LEAST(300, power(2, attempts)) * interval '1 second')
           ELSE available_at END,
         locked_at = NULL,
         lock_owner = NULL,
         last_error = $4
     WHERE id = $1 AND status = 'processing' AND lock_owner = $2`,
    [event.id, workerId, dead ? 'dead' : 'pending', message],
  );
}

function readPayloadString(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new PermanentJobError(`outbox payload is missing ${key}`);
  }
  return value;
}

class PermanentJobError extends Error {}
