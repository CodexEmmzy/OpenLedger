import { createHash } from 'node:crypto';
import type { Pool, PoolClient, QueryResultRow } from 'pg';

export type LedgerCurrency = string;
export type LedgerTransactionType = 'transfer' | 'deposit' | 'withdrawal' | 'reversal';
export type EntryDirection = 'debit' | 'credit';

export interface CreateCustomerAccountInput {
  currency: LedgerCurrency;
  displayName: string;
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
    `INSERT INTO accounts (display_name, currency, external_ref, kind, type)
     VALUES ($1, $2, $3, 'customer', 'liability')
     RETURNING id, currency, display_name, status, created_at`,
    [input.displayName, input.currency, input.externalRef ?? null],
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
