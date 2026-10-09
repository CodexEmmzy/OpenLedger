# Operational Reconciliation & Paystack Maintenance Runbook

This operational runbook details procedures for verifying payment provider credentials, managing webhook deliveries, investigating outbox dead-letter queues, performing manual balance-to-settlement reconciliations, and recovering from invariant mismatches.

---

## 1. Paystack Credential Setup & Sandbox Verification

Before deploying or running outbox payment workers against Paystack:

### 1.1 Credential Environment Variables

Ensure the following variables are injected via secure secret manager (e.g. AWS Secrets Manager, HashiCorp Vault):

- `PAYSTACK_SECRET_KEY`: Provider secret key (`sk_test_...` for sandbox, `sk_live_...` for production).
- `PAYSTACK_WEBHOOK_SECRET`: Secret key or signing secret used to compute HMAC-SHA512 signatures on inbound webhook events.

### 1.2 Verification Procedure

Run the automated credential verifier:

```bash
# Sandbox test verification
PAYSTACK_SECRET_KEY=sk_test_xxxx PAYSTACK_WEBHOOK_SECRET=secret_xxxx npm run paystack:verify

# Local mock test (when offline)
PAYSTACK_MOCK_VERIFY=true npm run paystack:verify
```

**Expected Result**:

- `Detected Credential Environment: SANDBOX / TEST` (or `PRODUCTION / LIVE`).
- `✓ Paystack API Response: Balance retrieved / Authorized`.
- `Status: PAYSTACK CREDENTIALS VERIFIED OK`.

---

## 2. Webhook Ingestion & Signature Failure Handling

Paystack webhooks are received at POST `/v1/providers/paystack/webhook`.

### 2.1 Webhook Validation Pipeline

1. **Raw Request Bytes**: Fastify captures unparsed body bytes for signature validation.
2. **HMAC-SHA512 Verification**: Signature in `x-paystack-signature` header is matched against `crypto.createHmac('sha512', PAYSTACK_WEBHOOK_SECRET).update(rawBytes).digest('hex')`.
3. **Deduplication**: Webhook payload event key (`event.data.reference`) and payload hash are stored in `provider_events`. Duplicate events return `200 OK` with `{ status: "duplicate_ignored" }`.

### 2.2 Investigating Signature Verification Failures

If HTTP `401 Unauthorized` or log `Paystack signature mismatch` alerts occur:

1. Verify `PAYSTACK_WEBHOOK_SECRET` in application environment matches the secret set in the Paystack Dashboard webhook settings.
2. Check for reverse-proxy modifications: Ensure upstream ingress proxies (e.g. NGINX, Cloudflare) do not modify raw request bodies or re-encode JSON payloads before forwarding to the Fastify API.

---

## 3. Outbox Dead-Letter Queue (DLQ) Operational Resolution

Background worker claims outbox jobs using `SELECT ... FOR UPDATE SKIP LOCKED`. If a job exceeds max retry attempts (`MAX_RETRIES = 5`), its status transitions to `dead_letter`.

### 3.1 Inspect Dead-Letter Jobs

Query dead-lettered events in PostgreSQL:

```sql
SELECT id, aggregate_id, event_type, retry_count, last_error, created_at, updated_at
FROM outbox_events
WHERE status = 'dead_letter'
ORDER BY created_at DESC;
```

### 3.2 Reprocessing Dead-Letter Jobs

Once underlying issues (network outage, Paystack API maintenance) are resolved:

```sql
-- Reset job to pending for re-execution by worker
UPDATE outbox_events
SET status = 'pending', retry_count = 0, last_error = NULL, updated_at = NOW()
WHERE id = 'DEAD_LETTER_EVENT_UUID';
```

---

## 4. Manual Financial Reconciliation Runbook

Perform periodic operational financial reconciliation between Paystack transaction exports and OpenLedger database entries.

### 4.1 Daily Settlement Audit Procedure

1. Export Paystack Settlement CSV for target date \( T \) from Paystack Dashboard.
2. Run database settlement reconciliation query:

```sql
SELECT
  pp.provider_reference,
  pp.amount_minor AS paystack_amount,
  e.amount_minor AS ledger_entry_amount,
  t.status AS transaction_status
FROM provider_payments pp
JOIN transactions t ON t.id = pp.transaction_id
JOIN entries e ON e.transaction_id = t.id AND e.account_id = pp.customer_account_id
WHERE pp.status = 'successful'
  AND pp.created_at >= 'YYYY-MM-DD 00:00:00'
  AND pp.created_at < 'YYYY-MM-DD 23:59:59';
```

3. Verify:
   - Sum of `paystack_amount` matches Paystack net settlement total.
   - Sum of `ledger_entry_amount` matches `provider_clearing` asset account credit sum.

---

## 5. Invariant Failure Incident Escalation

If `npm run ledger:check` or background invariant worker reports an invariant error:

1. **Immediate Action**: Stop money-movement API endpoints (`POST /v1/transfers`, `POST /v1/deposits/paystack/initiate`).
2. **Execute Audit Check**:
   ```bash
   npm run ledger:check
   ```
3. **Isolate Mismatched Account**:
   Query account balances vs journal sum:
   ```sql
   SELECT a.id, a.account_code, ab.amount_minor AS projected_balance, COALESCE(SUM(e.amount_minor), 0) AS journal_balance
   FROM accounts a
   JOIN account_balances ab ON ab.account_id = a.id
   LEFT JOIN entries e ON e.account_id = a.id
   GROUP BY a.id, a.account_code, ab.amount_minor
   HAVING ab.amount_minor <> COALESCE(SUM(e.amount_minor), 0);
   ```
4. **Rebuild Balance Projection**:
   If projection drift occurred due to abnormal shutdown during non-transactional database maintenance, execute balance recomputation via repo `recomputeAccountBalances()`.
