import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assertLedgerInvariants,
  createCustomerAccount,
  getAccountBalance,
  postLedgerTransaction,
} from '../src/modules/ledger/ledger-repository.js';

describe('ledger database invariants', () => {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  let clearingAccountId: string;

  beforeAll(async () => {
    const clearing = await pool.query<{ id: string }>(
      `SELECT id FROM accounts WHERE account_code = 'provider_clearing_NGN'`,
    );
    const row = clearing.rows[0];
    if (!row) {
      throw new Error('NGN provider clearing system account is missing; run migrations first');
    }
    clearingAccountId = row.id;
  });

  afterAll(async () => {
    await pool.end();
  });

  it('posts balanced entries and updates the natural-side balance projection', async () => {
    const wallet = await createWallet('NGN');
    const transaction = await postLedgerTransaction(pool, {
      idempotencyKey: `deposit:${randomUUID()}`,
      type: 'deposit',
      currency: 'NGN',
      entries: [
        { accountId: clearingAccountId, direction: 'debit', amountMinor: 2500n },
        { accountId: wallet.id, direction: 'credit', amountMinor: 2500n },
      ],
    });

    expect(transaction.duplicate).toBe(false);
    expect((await getAccountBalance(pool, wallet.id)).balanceMinor).toBe(2500n);
    expect((await getAccountBalance(pool, clearingAccountId)).balanceMinor).toBeGreaterThanOrEqual(
      2500n,
    );
  });

  it('rejects an unbalanced transaction at commit and rolls back entries and balances', async () => {
    const wallet = await createWallet('NGN');
    const idempotencyKey = `unbalanced:${randomUUID()}`;

    await expect(
      postLedgerTransaction(pool, {
        idempotencyKey,
        type: 'deposit',
        currency: 'NGN',
        entries: [{ accountId: wallet.id, direction: 'credit', amountMinor: 100n }],
      }),
    ).rejects.toThrow(/not balanced/);

    expect((await getAccountBalance(pool, wallet.id)).balanceMinor).toBe(0n);
    const persisted = await pool.query('SELECT 1 FROM transactions WHERE idempotency_key = $1', [
      idempotencyKey,
    ]);
    expect(persisted.rowCount).toBe(0);
  });

  it('rejects a customer overdraft in the database and rolls back the transaction', async () => {
    const wallet = await createWallet('NGN');

    await expect(
      postLedgerTransaction(pool, {
        idempotencyKey: `overdraft:${randomUUID()}`,
        type: 'withdrawal',
        currency: 'NGN',
        entries: [
          { accountId: wallet.id, direction: 'debit', amountMinor: 1n },
          { accountId: clearingAccountId, direction: 'credit', amountMinor: 1n },
        ],
      }),
    ).rejects.toThrow(/cannot have a negative balance/);

    expect((await getAccountBalance(pool, wallet.id)).balanceMinor).toBe(0n);
  });

  it('checks the final account balance after all entries in a transaction', async () => {
    const wallet = await createWallet('NGN');
    const suspenseResult = await pool.query<{ id: string }>(
      `SELECT id FROM accounts WHERE account_code = 'suspense_NGN'`,
    );
    const suspenseAccount = suspenseResult.rows[0];
    if (!suspenseAccount) {
      throw new Error('NGN suspense system account is missing; run migrations first');
    }

    const transaction = await postLedgerTransaction(pool, {
      idempotencyKey: `netting:${randomUUID()}`,
      type: 'transfer',
      currency: 'NGN',
      entries: [
        { accountId: wallet.id, direction: 'debit', amountMinor: 100n },
        { accountId: wallet.id, direction: 'credit', amountMinor: 100n },
        { accountId: clearingAccountId, direction: 'debit', amountMinor: 100n },
        { accountId: suspenseAccount.id, direction: 'credit', amountMinor: 100n },
      ],
    });

    expect(transaction.status).toBe('posted');
    expect((await getAccountBalance(pool, wallet.id)).balanceMinor).toBe(0n);
  });

  it('rejects mixed-currency entries before posting', async () => {
    const usdWallet = await createWallet('USD');

    await expect(
      postLedgerTransaction(pool, {
        idempotencyKey: `currency:${randomUUID()}`,
        type: 'deposit',
        currency: 'NGN',
        entries: [
          { accountId: clearingAccountId, direction: 'debit', amountMinor: 100n },
          { accountId: usdWallet.id, direction: 'credit', amountMinor: 100n },
        ],
      }),
    ).rejects.toThrow(/currency/);
  });

  it('returns one transaction for matching idempotent retries and rejects key reuse with a changed body', async () => {
    const wallet = await createWallet('NGN');
    const idempotencyKey = `retry:${randomUUID()}`;
    const input = {
      idempotencyKey,
      type: 'deposit' as const,
      currency: 'NGN',
      entries: [
        { accountId: clearingAccountId, direction: 'debit' as const, amountMinor: 700n },
        { accountId: wallet.id, direction: 'credit' as const, amountMinor: 700n },
      ],
    };

    const first = await postLedgerTransaction(pool, input);
    const retry = await postLedgerTransaction(pool, {
      ...input,
      entries: [...input.entries].reverse(),
    });

    expect(retry.id).toBe(first.id);
    expect(retry.duplicate).toBe(true);
    expect((await getAccountBalance(pool, wallet.id)).balanceMinor).toBe(700n);
    await expect(
      postLedgerTransaction(pool, {
        ...input,
        entries: input.entries.map((entry) => ({ ...entry, amountMinor: 701n })),
      }),
    ).rejects.toThrow(/different request/);
  });

  it('keeps entries append-only and records status history', async () => {
    const wallet = await createWallet('NGN');
    const transaction = await postLedgerTransaction(pool, {
      idempotencyKey: `immutable:${randomUUID()}`,
      type: 'deposit',
      currency: 'NGN',
      entries: [
        { accountId: clearingAccountId, direction: 'debit', amountMinor: 90n },
        { accountId: wallet.id, direction: 'credit', amountMinor: 90n },
      ],
    });
    const entry = await pool.query<{ id: string }>(
      'SELECT id FROM entries WHERE transaction_id = $1 ORDER BY id LIMIT 1',
      [transaction.id],
    );

    await expect(
      pool.query('DELETE FROM entries WHERE id = $1', [entry.rows[0]?.id]),
    ).rejects.toThrow(/append-only/);
    await expect(
      pool.query('UPDATE entries SET amount_minor = amount_minor + 1 WHERE id = $1', [
        entry.rows[0]?.id,
      ]),
    ).rejects.toThrow(/append-only/);
    await expect(
      pool.query('DELETE FROM account_balances WHERE account_id = $1', [wallet.id]),
    ).rejects.toThrow(/cannot be deleted or truncated/);
    const history = await pool.query<{ status: string }>(
      `SELECT status FROM transaction_status_history
       WHERE transaction_id = $1 ORDER BY id`,
      [transaction.id],
    );
    expect(history.rows.map((row) => row.status)).toEqual(['pending', 'posted']);
  });

  it('rejects a balance projection that does not match the journal at commit', async () => {
    const wallet = await createWallet('NGN');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('openledger.entry_balance_update', 'on', true)");
      await client.query(
        `UPDATE account_balances
         SET balance_minor = balance_minor + 1, version = version + 1
         WHERE account_id = $1`,
        [wallet.id],
      );
      await expect(client.query('COMMIT')).rejects.toThrow(/does not match posted entries/);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }

    expect((await getAccountBalance(pool, wallet.id)).balanceMinor).toBe(0n);
  });

  it('posts reversals as new transactions with exactly negated entries', async () => {
    const wallet = await createWallet('NGN');
    const original = await postLedgerTransaction(pool, {
      idempotencyKey: `original:${randomUUID()}`,
      type: 'deposit',
      currency: 'NGN',
      entries: [
        { accountId: clearingAccountId, direction: 'debit', amountMinor: 340n },
        { accountId: wallet.id, direction: 'credit', amountMinor: 340n },
      ],
    });

    await postLedgerTransaction(pool, {
      idempotencyKey: `reversal:${randomUUID()}`,
      type: 'reversal',
      currency: 'NGN',
      reversalOf: original.id,
      entries: [
        { accountId: wallet.id, direction: 'debit', amountMinor: 340n },
        { accountId: clearingAccountId, direction: 'credit', amountMinor: 340n },
      ],
    });

    expect((await getAccountBalance(pool, wallet.id)).balanceMinor).toBe(0n);
  });

  it('serializes 500 concurrent debits without overdrawing the hot account', async () => {
    const wallet = await createWallet('NGN');
    await postLedgerTransaction(pool, {
      idempotencyKey: `hot-account-funding:${randomUUID()}`,
      type: 'deposit',
      currency: 'NGN',
      entries: [
        { accountId: clearingAccountId, direction: 'debit', amountMinor: 1000n },
        { accountId: wallet.id, direction: 'credit', amountMinor: 1000n },
      ],
    });

    const results = await Promise.allSettled(
      Array.from({ length: 500 }, (_, index) =>
        postLedgerTransaction(pool, {
          idempotencyKey: `hot-account-debit:${wallet.id}:${index}`,
          type: 'withdrawal',
          currency: 'NGN',
          entries: [
            { accountId: wallet.id, direction: 'debit', amountMinor: 3n },
            { accountId: clearingAccountId, direction: 'credit', amountMinor: 3n },
          ],
        }),
      ),
    );
    const succeeded = results.filter((result) => result.status === 'fulfilled');
    const failed = results.filter((result) => result.status === 'rejected');

    expect(succeeded).toHaveLength(333);
    expect(failed).toHaveLength(167);
    expect((await getAccountBalance(pool, wallet.id)).balanceMinor).toBe(1n);
  }, 30_000);

  it('recomputes all account balances from the journal', async () => {
    const report = await assertLedgerInvariants(pool);
    expect(report.accountsChecked).toBeGreaterThanOrEqual(6);
    expect(report.balanceMismatches).toEqual([]);
    expect(report.unbalancedTransactionIds).toEqual([]);
  });

  async function createWallet(currency: 'NGN' | 'USD') {
    return createCustomerAccount(pool, {
      currency,
      displayName: 'Integration test wallet',
      externalRef: `integration:${randomUUID()}`,
    });
  }
});
