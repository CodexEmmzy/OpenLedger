import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient, QueryResultRow } from 'pg';

export type LedgerCurrency = string;
export type LedgerTransactionType = 'transfer' | 'deposit' | 'withdrawal' | 'reversal';
export type EntryDirection = 'debit' | 'credit';

export interface CreateCustomerAccountInput {
  currency: LedgerCurrency;
  displayName: string;
  ownerSubject: string;
  externalRef?: string;
}

export interface CustomerAccount {
  id: string;
  currency: LedgerCurrency;
  displayName: string;
  status: 'active' | 'frozen' | 'closed';
  createdAt: Date;
}

export interface LedgerEntryInput {
  accountId: string;
  direction: EntryDirection;
  amountMinor: bigint;
}

export interface PostLedgerTransactionInput {
  idempotencyKey: string;
  type: LedgerTransactionType;
  currency: LedgerCurrency;
  entries: LedgerEntryInput[];
  reversalOf?: string;
}

export interface PostedTransaction {
  id: string;
  status: 'posted';
  duplicate: boolean;
}

export interface OwnedTransfer {
  id: string;
  sourceAccountId: string;
  destinationAccountId: string;
  amountMinor: bigint;
  currency: string;
  createdAt: Date;
}

export interface CreatePaymentIntentInput {
  reference: string;
  idempotencyKey: string;
  accountId: string;
  ownerSubject: string;
  amountMinor: bigint;
  currency: LedgerCurrency;
  customerEmail: string;
}

export interface ProviderPayment {
  reference: string;
  accountId: string;
  amountMinor: bigint;
  currency: string;
  status: 'pending' | 'initialized' | 'succeeded' | 'failed' | 'reconciliation_required';
  authorizationUrl: string | null;
  createdAt: Date;
  duplicate: boolean;
}

export type PaystackEventInsertResult = 'inserted' | 'duplicate' | 'conflict';

interface AccountLockRow extends QueryResultRow {
  id: string;
  currency: string;
  status: CustomerAccount['status'];
}

interface TransactionRow extends QueryResultRow {
  id: string;
  request_hash: string;
  status: 'pending' | 'posted' | 'failed';
}

interface AccountBalanceRow extends QueryResultRow {
  account_id: string;
  currency: string;
  balance_minor: string;
  version: string;
  updated_at: Date;
}

interface BalanceMismatchRow extends QueryResultRow {
  account_id: string;
  recorded_minor: string;
  computed_minor: string;
}

interface UnbalancedTransactionRow extends QueryResultRow {
  id: string;
}

export interface LedgerInvariantReport {
  accountsChecked: number;
  balanceMismatches: Array<{
    accountId: string;
    recordedMinor: bigint;
    computedMinor: bigint;
  }>;
  unbalancedTransactionIds: string[];
}

export class IdempotencyConflictError extends Error {
  constructor(key: string) {
    super(`idempotency key was already used with a different request: ${key}`);
    this.name = 'IdempotencyConflictError';
  }
}

export async function createCustomerAccount(
  pool: Pool,
  input: CreateCustomerAccountInput,
): Promise<CustomerAccount> {
  const result = await pool.query<{
    id: string;
    currency: string;
    display_name: string;
    status: CustomerAccount['status'];
    created_at: Date;
  }>(
    `INSERT INTO accounts (display_name, currency, external_ref, owner_subject, kind, type)
     VALUES ($1, $2, $3, $4, 'customer', 'liability')
     RETURNING id, currency, display_name, status, created_at`,
    [input.displayName, input.currency, input.externalRef ?? null, input.ownerSubject],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error('account insert returned no row');
  }
  return {
    id: row.id,
    currency: row.currency,
    displayName: row.display_name,
    status: row.status,
    createdAt: row.created_at,
  };
}

export async function getCustomerAccountForOwner(
  pool: Pool,
  accountId: string,
  ownerSubject: string,
): Promise<CustomerAccount | null> {
  const result = await pool.query<{
    id: string;
    currency: string;
    display_name: string;
    status: CustomerAccount['status'];
    created_at: Date;
  }>(
    `SELECT id, currency, display_name, status, created_at
     FROM accounts
     WHERE id = $1 AND owner_subject = $2 AND kind = 'customer'`,
    [accountId, ownerSubject],
  );
  const row = result.rows[0];
  return row
    ? {
        id: row.id,
        currency: row.currency,
        displayName: row.display_name,
        status: row.status,
        createdAt: row.created_at,
      }
    : null;
}

export async function getTransferForOwner(
  pool: Pool,
  transactionId: string,
  ownerSubject: string,
): Promise<OwnedTransfer | null> {
  const result = await pool.query<{
    id: string;
    source_account_id: string;
    destination_account_id: string;
    amount_minor: string;
    currency: string;
    created_at: Date;
  }>(
    `SELECT t.id,
       max(e.account_id::text) FILTER (WHERE e.direction = 'debit') AS source_account_id,
       max(e.account_id::text) FILTER (WHERE e.direction = 'credit') AS destination_account_id,
       sum(e.amount_minor) FILTER (WHERE e.direction = 'debit')::text AS amount_minor,
       t.currency,
       t.created_at
     FROM transactions t
     JOIN entries e ON e.transaction_id = t.id
     JOIN accounts a ON a.id = e.account_id
     WHERE t.id = $1 AND t.type = 'transfer' AND t.status = 'posted'
     GROUP BY t.id, t.currency, t.created_at
     HAVING count(*) = 2 AND bool_and(a.kind = 'customer' AND a.owner_subject = $2)`,
    [transactionId, ownerSubject],
  );
  const row = result.rows[0];
  return row
    ? {
        id: row.id,
        sourceAccountId: row.source_account_id,
        destinationAccountId: row.destination_account_id,
        amountMinor: BigInt(row.amount_minor),
        currency: row.currency,
        createdAt: row.created_at,
      }
    : null;
}

export async function createPaystackPaymentIntent(
  pool: Pool,
  input: CreatePaymentIntentInput,
): Promise<ProviderPayment> {
  const requestHash = createHash('sha256')
    .update(
      JSON.stringify({
        accountId: input.accountId,
        ownerSubject: input.ownerSubject,
        amountMinor: input.amountMinor.toString(),
        currency: input.currency,
        customerEmail: input.customerEmail.trim().toLowerCase(),
      }),
    )
    .digest('hex');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query<ProviderPaymentRow & { request_hash: string }>(
      `SELECT reference, account_id, amount_minor::text, currency, status,
         authorization_url, created_at, request_hash
       FROM provider_payments WHERE idempotency_key = $1 FOR UPDATE`,
      [input.idempotencyKey],
    );
    const existingPayment = existing.rows[0];
    if (existingPayment) {
      if (existingPayment.request_hash !== requestHash) {
        throw new IdempotencyConflictError(input.idempotencyKey);
      }
      await client.query('COMMIT');
      return mapProviderPayment(existingPayment, true);
    }
    const account = await client.query<{ currency: string; status: string }>(
      `SELECT currency, status
       FROM accounts
       WHERE id = $1 AND owner_subject = $2 AND kind = 'customer'
       FOR UPDATE`,
      [input.accountId, input.ownerSubject],
    );
    const ownerAccount = account.rows[0];
    if (!ownerAccount) {
      throw new Error('account not found');
    }
    if (ownerAccount.status !== 'active' || ownerAccount.currency !== input.currency) {
      throw new Error('account status or currency does not permit this payment');
    }

    const result = await client.query<{
      reference: string;
      account_id: string;
      amount_minor: string;
      currency: string;
      status: ProviderPayment['status'];
      authorization_url: string | null;
      created_at: Date;
    }>(
      `INSERT INTO provider_payments
        (reference, idempotency_key, request_hash, account_id, owner_subject, amount_minor, currency, customer_email)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING reference, account_id, amount_minor::text, currency, status, authorization_url, created_at`,
      [
        input.reference,
        input.idempotencyKey,
        requestHash,
        input.accountId,
        input.ownerSubject,
        input.amountMinor.toString(),
        input.currency,
        input.customerEmail,
      ],
    );
    const payment = result.rows[0];
    if (!payment) {
      const raced = await client.query<ProviderPaymentRow & { request_hash: string }>(
        `SELECT reference, account_id, amount_minor::text, currency, status,
           authorization_url, created_at, request_hash
         FROM provider_payments WHERE idempotency_key = $1 FOR UPDATE`,
        [input.idempotencyKey],
      );
      const racedPayment = raced.rows[0];
      if (!racedPayment) {
        throw new Error('payment idempotency conflict did not return an existing intent');
      }
      if (racedPayment.request_hash !== requestHash) {
        throw new IdempotencyConflictError(input.idempotencyKey);
      }
      await client.query('COMMIT');
      return mapProviderPayment(racedPayment, true);
    }
    await client.query(
      `INSERT INTO outbox_events (event_type, aggregate_id, payload)
       SELECT 'provider.paystack.initialize', id, jsonb_build_object('reference', reference)
       FROM provider_payments WHERE reference = $1`,
      [input.reference],
    );
    await client.query('COMMIT');
    return mapProviderPayment(payment);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function getProviderPaymentForOwner(
  pool: Pool,
  reference: string,
  ownerSubject: string,
): Promise<ProviderPayment | null> {
  const result = await pool.query<ProviderPaymentRow>(
    `SELECT reference, account_id, amount_minor::text, currency, status, authorization_url, created_at
     FROM provider_payments WHERE reference = $1 AND owner_subject = $2`,
    [reference, ownerSubject],
  );
  return result.rows[0] ? mapProviderPayment(result.rows[0]) : null;
}

interface ProviderPaymentRow extends QueryResultRow {
  reference: string;
  account_id: string;
  amount_minor: string;
  currency: string;
  status: ProviderPayment['status'];
  authorization_url: string | null;
  created_at: Date;
}

function mapProviderPayment(row: ProviderPaymentRow, duplicate = false): ProviderPayment {
  return {
    reference: row.reference,
    accountId: row.account_id,
    amountMinor: BigInt(row.amount_minor),
    currency: row.currency,
    status: row.status,
    authorizationUrl: row.authorization_url,
    createdAt: row.created_at,
    duplicate,
  };
}

export async function recordPaystackEvent(
  pool: Pool,
  event: {
    eventKey: string;
    eventType: string;
    reference: string;
    amountMinor: bigint;
    currency: string;
    payloadHash: string;
  },
): Promise<PaystackEventInsertResult> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO provider_events
        (provider, event_key, event_type, reference, amount_minor, currency, payload_hash)
       VALUES ('paystack', $1, $2, $3, $4, $5, $6)
       ON CONFLICT (provider, event_key) DO NOTHING
       RETURNING id`,
      [
        event.eventKey,
        event.eventType,
        event.reference,
        event.amountMinor.toString(),
        event.currency,
        event.payloadHash,
      ],
    );
    const row = inserted.rows[0];
    if (!row) {
      const prior = await client.query<{ payload_hash: string }>(
        `SELECT payload_hash FROM provider_events
         WHERE provider = 'paystack' AND event_key = $1
         FOR UPDATE`,
        [event.eventKey],
      );
      await client.query('COMMIT');
      return prior.rows[0]?.payload_hash === event.payloadHash ? 'duplicate' : 'conflict';
    }

    await client.query(
      `INSERT INTO outbox_events (event_type, aggregate_id, payload)
        VALUES ('provider.paystack.event', $1, jsonb_build_object('eventId', $2::text))`,
      [randomUUID(), row.id],
    );
    await client.query('COMMIT');
    return 'inserted';
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function postLedgerTransaction(
  pool: Pool,
  input: PostLedgerTransactionInput,
): Promise<PostedTransaction> {
  const requestHash = hashRequest(input);
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO transactions
        (idempotency_key, request_hash, type, currency, reversal_of)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING id`,
      [input.idempotencyKey, requestHash, input.type, input.currency, input.reversalOf ?? null],
    );

    const newTransaction = inserted.rows[0];
    if (!newTransaction) {
      const existing = await client.query<TransactionRow>(
        `SELECT id, request_hash, status
         FROM transactions
         WHERE idempotency_key = $1
         FOR UPDATE`,
        [input.idempotencyKey],
      );
      const existingTransaction = existing.rows[0];
      if (!existingTransaction) {
        throw new Error('idempotency conflict did not return the existing transaction');
      }
      if (existingTransaction.request_hash.trim() !== requestHash) {
        throw new IdempotencyConflictError(input.idempotencyKey);
      }
      if (existingTransaction.status !== 'posted') {
        throw new Error(
          `existing transaction has unexpected status: ${existingTransaction.status}`,
        );
      }
      await client.query('COMMIT');
      return { id: existingTransaction.id, status: 'posted', duplicate: true };
    }

    await lockAndValidateAccounts(client, input);
    if (input.entries.length > 0) {
      await client.query(
        `INSERT INTO entries (transaction_id, account_id, direction, amount_minor)
         SELECT $1, entry.account_id, entry.direction, entry.amount_minor
         FROM unnest($2::uuid[], $3::entry_direction[], $4::bigint[])
           AS entry(account_id, direction, amount_minor)`,
        [
          newTransaction.id,
          input.entries.map((entry) => entry.accountId),
          input.entries.map((entry) => entry.direction),
          input.entries.map((entry) => entry.amountMinor.toString()),
        ],
      );
    }
    await client.query(
      `UPDATE transactions
       SET status = 'posted', status_reason = 'posted'
       WHERE id = $1`,
      [newTransaction.id],
    );
    await client.query('COMMIT');
    return { id: newTransaction.id, status: 'posted', duplicate: false };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function getAccountBalance(
  pool: Pool,
  accountId: string,
): Promise<{
  accountId: string;
  currency: string;
  balanceMinor: bigint;
  version: bigint;
  updatedAt: Date;
}> {
  const result = await pool.query<AccountBalanceRow>(
    `SELECT b.account_id, a.currency, b.balance_minor::text, b.version::text, b.updated_at
     FROM account_balances b
     JOIN accounts a ON a.id = b.account_id
     WHERE b.account_id = $1`,
    [accountId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error(`account balance not found: ${accountId}`);
  }
  return {
    accountId: row.account_id,
    currency: row.currency,
    balanceMinor: BigInt(row.balance_minor),
    version: BigInt(row.version),
    updatedAt: row.updated_at,
  };
}

export async function checkLedgerInvariants(pool: Pool): Promise<LedgerInvariantReport> {
  const [balanceResult, transactionResult] = await Promise.all([
    pool.query<BalanceMismatchRow>(`
      SELECT a.id AS account_id,
        b.balance_minor::text AS recorded_minor,
        COALESCE(sum(
          CASE
            WHEN e.id IS NULL THEN 0
            WHEN (a.type IN ('asset', 'expense') AND e.direction = 'debit')
              OR (a.type IN ('liability', 'equity', 'income') AND e.direction = 'credit')
              THEN e.amount_minor
            ELSE -e.amount_minor
          END
        ), 0)::text AS computed_minor
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
      ), 0)`),
    pool.query<UnbalancedTransactionRow>(`
      SELECT t.id
      FROM transactions t
      LEFT JOIN entries e ON e.transaction_id = t.id
      WHERE t.status = 'posted'
      GROUP BY t.id
      HAVING count(e.id) < 2
        OR count(DISTINCT e.account_id) < 2
        OR COALESCE(sum(e.amount_minor) FILTER (WHERE e.direction = 'debit'), 0) <= 0
        OR COALESCE(sum(e.amount_minor) FILTER (WHERE e.direction = 'debit'), 0)
          <> COALESCE(sum(e.amount_minor) FILTER (WHERE e.direction = 'credit'), 0)`),
  ]);
  const countResult = await pool.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM accounts',
  );

  return {
    accountsChecked: Number(countResult.rows[0]?.count ?? '0'),
    balanceMismatches: balanceResult.rows.map((row) => ({
      accountId: row.account_id,
      recordedMinor: BigInt(row.recorded_minor),
      computedMinor: BigInt(row.computed_minor),
    })),
    unbalancedTransactionIds: transactionResult.rows.map((row) => row.id),
  };
}

export async function assertLedgerInvariants(pool: Pool): Promise<LedgerInvariantReport> {
  const report = await checkLedgerInvariants(pool);
  if (report.balanceMismatches.length > 0 || report.unbalancedTransactionIds.length > 0) {
    throw new Error(
      `ledger invariant violation: ${JSON.stringify({
        balanceMismatches: report.balanceMismatches.map((mismatch) => ({
          ...mismatch,
          recordedMinor: mismatch.recordedMinor.toString(),
          computedMinor: mismatch.computedMinor.toString(),
        })),
        unbalancedTransactionIds: report.unbalancedTransactionIds,
      })}`,
    );
  }
  return report;
}

async function lockAndValidateAccounts(
  client: PoolClient,
  input: PostLedgerTransactionInput,
): Promise<void> {
  const accountIds = [...new Set(input.entries.map((entry) => entry.accountId))].sort();
  if (input.reversalOf) {
    const original = await client.query<{ currency: string; status: string }>(
      'SELECT currency, status FROM transactions WHERE id = $1 FOR UPDATE',
      [input.reversalOf],
    );
    const originalTransaction = original.rows[0];
    if (!originalTransaction || originalTransaction.status !== 'posted') {
      throw new Error('reversal must reference an existing posted transaction');
    }
    if (originalTransaction.currency !== input.currency) {
      throw new Error('reversal currency must match the original transaction');
    }
  }

  const result = await client.query<AccountLockRow>(
    `SELECT id, currency, status
     FROM accounts
     WHERE id = ANY($1::uuid[])
     ORDER BY id
     FOR UPDATE`,
    [accountIds],
  );
  if (result.rows.length !== accountIds.length) {
    const found = new Set(result.rows.map((row) => row.id));
    const missing = accountIds.filter((id) => !found.has(id));
    throw new Error(`accounts not found: ${missing.join(', ')}`);
  }
  for (const account of result.rows) {
    if (account.status !== 'active') {
      throw new Error(`account is not active: ${account.id}`);
    }
    if (account.currency !== input.currency) {
      throw new Error(`transaction currency does not match account: ${account.id}`);
    }
  }
}

function hashRequest(input: PostLedgerTransactionInput): string {
  const canonical = {
    type: input.type,
    currency: input.currency,
    reversalOf: input.reversalOf ?? null,
    entries: input.entries
      .map((entry) => ({
        accountId: entry.accountId,
        direction: entry.direction,
        amountMinor: entry.amountMinor.toString(),
      }))
      .sort((left, right) =>
        `${left.accountId}:${left.direction}:${left.amountMinor}`.localeCompare(
          `${right.accountId}:${right.direction}:${right.amountMinor}`,
        ),
      ),
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}
