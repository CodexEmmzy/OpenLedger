/** @type {import('node-pg-migrate').MigrationBuilder} */
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TYPE account_kind AS ENUM ('customer', 'system');
    CREATE TYPE account_type AS ENUM ('asset', 'liability', 'equity', 'income', 'expense');
    CREATE TYPE account_status AS ENUM ('active', 'frozen', 'closed');
    CREATE TYPE ledger_transaction_type AS ENUM ('transfer', 'deposit', 'withdrawal', 'reversal');
    CREATE TYPE ledger_transaction_status AS ENUM ('pending', 'posted', 'failed');
    CREATE TYPE entry_direction AS ENUM ('debit', 'credit');

    CREATE TABLE accounts (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      account_code text UNIQUE,
      external_ref text UNIQUE,
      display_name text NOT NULL CHECK (length(btrim(display_name)) > 0),
      currency char(3) NOT NULL CHECK (currency IN ('NGN', 'USD')),
      kind account_kind NOT NULL DEFAULT 'customer',
      type account_type NOT NULL DEFAULT 'liability',
      status account_status NOT NULL DEFAULT 'active',
      allow_negative boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now(),
      CHECK (
        (kind = 'system' AND account_code IS NOT NULL AND external_ref IS NULL)
        OR (kind = 'customer' AND account_code IS NULL)
      )
    );

    CREATE TABLE transactions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      idempotency_key varchar(128) NOT NULL UNIQUE
        CHECK (length(btrim(idempotency_key)) > 0),
      request_hash char(64) NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
      type ledger_transaction_type NOT NULL,
      status ledger_transaction_status NOT NULL DEFAULT 'pending',
      currency char(3) NOT NULL CHECK (currency IN ('NGN', 'USD')),
      reversal_of uuid UNIQUE REFERENCES transactions(id) ON DELETE RESTRICT,
      status_reason text NOT NULL DEFAULT 'created'
        CHECK (length(btrim(status_reason)) > 0),
      created_at timestamptz NOT NULL DEFAULT now(),
      CHECK ((type = 'reversal') = (reversal_of IS NOT NULL)),
      CHECK (reversal_of IS NULL OR reversal_of <> id)
    );

    CREATE TABLE account_balances (
      account_id uuid PRIMARY KEY REFERENCES accounts(id) ON DELETE RESTRICT,
      balance_minor bigint NOT NULL DEFAULT 0,
      version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE entries (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      transaction_id uuid NOT NULL REFERENCES transactions(id) ON DELETE RESTRICT,
      account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
      direction entry_direction NOT NULL,
      amount_minor bigint NOT NULL CHECK (amount_minor > 0),
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE INDEX entries_transaction_idx ON entries (transaction_id);
    CREATE INDEX entries_account_created_idx ON entries (account_id, created_at, id);

    CREATE TABLE transaction_status_history (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      transaction_id uuid NOT NULL REFERENCES transactions(id) ON DELETE RESTRICT,
      previous_status ledger_transaction_status,
      status ledger_transaction_status NOT NULL,
      reason text NOT NULL CHECK (length(btrim(reason)) > 0),
      changed_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE INDEX transaction_status_history_tx_idx
      ON transaction_status_history (transaction_id, changed_at, id);

    CREATE FUNCTION create_account_balance() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      INSERT INTO account_balances (account_id) VALUES (NEW.id);
      RETURN NEW;
    END;
    $$;

    CREATE TRIGGER accounts_create_balance
      AFTER INSERT ON accounts
      FOR EACH ROW EXECUTE FUNCTION create_account_balance();

    CREATE FUNCTION guard_account_definition() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      IF OLD.currency IS DISTINCT FROM NEW.currency
        OR OLD.kind IS DISTINCT FROM NEW.kind
        OR OLD.type IS DISTINCT FROM NEW.type
        OR OLD.account_code IS DISTINCT FROM NEW.account_code
        OR OLD.external_ref IS DISTINCT FROM NEW.external_ref
        OR OLD.allow_negative IS DISTINCT FROM NEW.allow_negative THEN
        RAISE EXCEPTION 'account identity and ledger classification are immutable'
          USING ERRCODE = '55000';
      END IF;
      RETURN NEW;
    END;
    $$;

    CREATE TRIGGER accounts_definition_immutable
      BEFORE UPDATE ON accounts
      FOR EACH ROW EXECUTE FUNCTION guard_account_definition();

    CREATE FUNCTION guard_balance_projection() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP = 'INSERT' THEN
        IF NEW.balance_minor <> 0 OR NEW.version <> 0 THEN
          RAISE EXCEPTION 'account balances are maintained by ledger entries'
            USING ERRCODE = '55000';
        END IF;
      ELSE
        IF current_setting('openledger.entry_balance_update', true) IS DISTINCT FROM 'on' THEN
          RAISE EXCEPTION 'account balances are maintained by ledger entries'
            USING ERRCODE = '55000';
        END IF;
        IF NEW.version <> OLD.version + 1 THEN
          RAISE EXCEPTION 'account balance version must increment by one'
            USING ERRCODE = '23514';
        END IF;
        IF NEW.account_id IS DISTINCT FROM OLD.account_id THEN
          RAISE EXCEPTION 'account balance identity is immutable'
            USING ERRCODE = '55000';
        END IF;
      END IF;

      NEW.updated_at := now();
      RETURN NEW;
    END;
    $$;

    CREATE TRIGGER account_balances_guard_insert
      BEFORE INSERT ON account_balances
      FOR EACH ROW EXECUTE FUNCTION guard_balance_projection();
    CREATE TRIGGER account_balances_guard_update
      BEFORE UPDATE ON account_balances
      FOR EACH ROW EXECUTE FUNCTION guard_balance_projection();

    CREATE FUNCTION reject_balance_projection_delete() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'account balance projections cannot be deleted or truncated'
        USING ERRCODE = '55000';
    END;
    $$;

    CREATE TRIGGER account_balances_no_delete
      BEFORE DELETE ON account_balances
      FOR EACH ROW EXECUTE FUNCTION reject_balance_projection_delete();
    CREATE TRIGGER account_balances_no_truncate
      BEFORE TRUNCATE ON account_balances
      FOR EACH STATEMENT EXECUTE FUNCTION reject_balance_projection_delete();

    CREATE FUNCTION enforce_nonnegative_customer_balance() RETURNS trigger
    LANGUAGE plpgsql AS $$
    DECLARE
      v_balance_minor bigint;
      v_allow_negative boolean;
    BEGIN
      SELECT b.balance_minor, a.allow_negative
      INTO v_balance_minor, v_allow_negative
      FROM account_balances b
      JOIN accounts a ON a.id = b.account_id
      WHERE b.account_id = NEW.account_id;
      IF FOUND AND v_balance_minor < 0 AND NOT v_allow_negative THEN
        RAISE EXCEPTION 'account % cannot have a negative balance', NEW.account_id
          USING ERRCODE = '23514';
      END IF;
      RETURN NULL;
    END;
    $$;

    CREATE CONSTRAINT TRIGGER customer_balance_must_be_nonnegative
      AFTER INSERT OR UPDATE ON account_balances
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION enforce_nonnegative_customer_balance();

    CREATE FUNCTION enforce_balance_matches_journal() RETURNS trigger
    LANGUAGE plpgsql AS $$
    DECLARE
      v_account_id uuid;
      v_account_type account_type;
      v_recorded_balance bigint;
      v_computed_balance numeric;
    BEGIN
      v_account_id := NEW.account_id;
      SELECT a.type, b.balance_minor
      INTO v_account_type, v_recorded_balance
      FROM accounts a
      JOIN account_balances b ON b.account_id = a.id
      WHERE a.id = v_account_id;
      IF NOT FOUND THEN
        RETURN NULL;
      END IF;

      SELECT COALESCE(sum(
        CASE
          WHEN (v_account_type IN ('asset', 'expense') AND e.direction = 'debit')
            OR (v_account_type IN ('liability', 'equity', 'income') AND e.direction = 'credit')
            THEN e.amount_minor
          ELSE -e.amount_minor
        END
      ), 0)
      INTO v_computed_balance
      FROM entries e
      JOIN transactions t ON t.id = e.transaction_id AND t.status = 'posted'
      WHERE e.account_id = v_account_id;

      IF v_recorded_balance::numeric <> v_computed_balance THEN
        RAISE EXCEPTION 'account % balance projection does not match posted entries', v_account_id
          USING ERRCODE = '23514';
      END IF;
      RETURN NULL;
    END;
    $$;

    CREATE CONSTRAINT TRIGGER account_balance_matches_journal
      AFTER INSERT OR UPDATE ON account_balances
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION enforce_balance_matches_journal();
    CREATE CONSTRAINT TRIGGER entry_balance_matches_journal
      AFTER INSERT ON entries
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION enforce_balance_matches_journal();

    CREATE FUNCTION validate_entry_insert() RETURNS trigger
    LANGUAGE plpgsql AS $$
    DECLARE
      v_transaction transactions%ROWTYPE;
      v_account accounts%ROWTYPE;
      v_delta bigint;
      v_balance_updated boolean;
    BEGIN
      SELECT * INTO v_transaction FROM transactions WHERE id = NEW.transaction_id;
      IF NOT FOUND OR v_transaction.status <> 'pending' THEN
        RAISE EXCEPTION 'entries can only be added to a pending transaction'
          USING ERRCODE = '23514';
      END IF;

      SELECT * INTO v_account FROM accounts WHERE id = NEW.account_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'account % does not exist', NEW.account_id
          USING ERRCODE = '23503';
      END IF;
      IF v_account.status <> 'active' THEN
        RAISE EXCEPTION 'account % is not active', NEW.account_id
          USING ERRCODE = '23514';
      END IF;
      IF v_account.currency <> v_transaction.currency THEN
        RAISE EXCEPTION 'transaction and account currencies must match'
          USING ERRCODE = '23514';
      END IF;

      IF (v_account.type IN ('asset', 'expense') AND NEW.direction = 'debit')
        OR (v_account.type IN ('liability', 'equity', 'income') AND NEW.direction = 'credit') THEN
        v_delta := NEW.amount_minor;
      ELSE
        v_delta := -NEW.amount_minor;
      END IF;

      PERFORM set_config('openledger.entry_balance_update', 'on', true);
      UPDATE account_balances
      SET balance_minor = balance_minor + v_delta,
          version = version + 1
      WHERE account_id = NEW.account_id;
      v_balance_updated := FOUND;
      PERFORM set_config('openledger.entry_balance_update', 'off', true);
      IF NOT v_balance_updated THEN
        RAISE EXCEPTION 'balance projection missing for account %', NEW.account_id
          USING ERRCODE = '23503';
      END IF;
      RETURN NEW;
    END;
    $$;

    CREATE TRIGGER entries_validate_and_update_balance
      BEFORE INSERT ON entries
      FOR EACH ROW EXECUTE FUNCTION validate_entry_insert();

    CREATE FUNCTION reject_ledger_mutation() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION '% is append-only', TG_TABLE_NAME
        USING ERRCODE = '55000';
    END;
    $$;

    CREATE TRIGGER entries_no_update_delete
      BEFORE UPDATE OR DELETE ON entries
      FOR EACH ROW EXECUTE FUNCTION reject_ledger_mutation();
    CREATE TRIGGER entries_no_truncate
      BEFORE TRUNCATE ON entries
      FOR EACH STATEMENT EXECUTE FUNCTION reject_ledger_mutation();
    CREATE TRIGGER status_history_no_update_delete
      BEFORE UPDATE OR DELETE ON transaction_status_history
      FOR EACH ROW EXECUTE FUNCTION reject_ledger_mutation();
    CREATE TRIGGER status_history_no_truncate
      BEFORE TRUNCATE ON transaction_status_history
      FOR EACH STATEMENT EXECUTE FUNCTION reject_ledger_mutation();

    CREATE FUNCTION guard_transaction_update() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      IF OLD.idempotency_key IS DISTINCT FROM NEW.idempotency_key
        OR OLD.request_hash IS DISTINCT FROM NEW.request_hash
        OR OLD.type IS DISTINCT FROM NEW.type
        OR OLD.currency IS DISTINCT FROM NEW.currency
        OR OLD.reversal_of IS DISTINCT FROM NEW.reversal_of
        OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
        RAISE EXCEPTION 'transaction identity is immutable'
          USING ERRCODE = '55000';
      END IF;
      IF OLD.status IS DISTINCT FROM NEW.status THEN
        IF OLD.status <> 'pending' OR NEW.status NOT IN ('posted', 'failed') THEN
          RAISE EXCEPTION 'transaction status can only move from pending to posted or failed'
            USING ERRCODE = '23514';
        END IF;
        IF length(btrim(NEW.status_reason)) = 0 THEN
          RAISE EXCEPTION 'status changes require a reason'
            USING ERRCODE = '23514';
        END IF;
        IF NEW.status_reason IS NOT DISTINCT FROM OLD.status_reason THEN
          RAISE EXCEPTION 'status changes require a new reason'
            USING ERRCODE = '23514';
        END IF;
      ELSIF OLD.status_reason IS DISTINCT FROM NEW.status_reason THEN
        RAISE EXCEPTION 'status reason can only change with status'
          USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END;
    $$;

    CREATE TRIGGER transactions_guard_update
      BEFORE UPDATE ON transactions
      FOR EACH ROW EXECUTE FUNCTION guard_transaction_update();
    CREATE TRIGGER transactions_no_delete
      BEFORE DELETE ON transactions
      FOR EACH ROW EXECUTE FUNCTION reject_ledger_mutation();

    CREATE FUNCTION record_transaction_status() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP = 'INSERT' THEN
        INSERT INTO transaction_status_history
          (transaction_id, previous_status, status, reason)
        VALUES (NEW.id, NULL, NEW.status, NEW.status_reason);
      ELSIF OLD.status IS DISTINCT FROM NEW.status THEN
        INSERT INTO transaction_status_history
          (transaction_id, previous_status, status, reason)
        VALUES (NEW.id, OLD.status, NEW.status, NEW.status_reason);
      END IF;
      RETURN NEW;
    END;
    $$;

    CREATE TRIGGER transactions_status_history_insert
      AFTER INSERT ON transactions
      FOR EACH ROW EXECUTE FUNCTION record_transaction_status();
    CREATE TRIGGER transactions_status_history_update
      AFTER UPDATE OF status ON transactions
      FOR EACH ROW EXECUTE FUNCTION record_transaction_status();

    CREATE FUNCTION enforce_transaction_balance() RETURNS trigger
    LANGUAGE plpgsql AS $$
    DECLARE
      v_transaction_id uuid;
      v_transaction transactions%ROWTYPE;
      v_entry_count bigint;
      v_account_count bigint;
      v_debits numeric;
      v_credits numeric;
    BEGIN
      IF TG_TABLE_NAME = 'transactions' THEN
        v_transaction_id := NEW.id;
      ELSE
        v_transaction_id := NEW.transaction_id;
      END IF;

      SELECT * INTO v_transaction FROM transactions WHERE id = v_transaction_id;
      IF NOT FOUND THEN
        RETURN NULL;
      END IF;
      IF v_transaction.status = 'pending' THEN
        RAISE EXCEPTION 'transaction % cannot commit while pending', v_transaction_id
          USING ERRCODE = '23514';
      END IF;

      SELECT count(*), count(DISTINCT account_id),
        COALESCE(sum(amount_minor) FILTER (WHERE direction = 'debit'), 0),
        COALESCE(sum(amount_minor) FILTER (WHERE direction = 'credit'), 0)
      INTO v_entry_count, v_account_count, v_debits, v_credits
      FROM entries WHERE transaction_id = v_transaction_id;

      IF v_transaction.status = 'failed' THEN
        IF v_entry_count <> 0 THEN
          RAISE EXCEPTION 'failed transaction % cannot contain entries', v_transaction_id
            USING ERRCODE = '23514';
        END IF;
        RETURN NULL;
      END IF;

      IF v_entry_count < 2 OR v_account_count < 2 OR v_debits <= 0 OR v_debits <> v_credits THEN
        RAISE EXCEPTION 'posted transaction % is not balanced', v_transaction_id
          USING ERRCODE = '23514';
      END IF;

      IF EXISTS (
        SELECT 1
        FROM entries e
        JOIN accounts a ON a.id = e.account_id
        WHERE e.transaction_id = v_transaction_id
          AND a.currency <> v_transaction.currency
      ) THEN
        RAISE EXCEPTION 'transaction % contains a currency mismatch', v_transaction_id
          USING ERRCODE = '23514';
      END IF;

      IF v_transaction.type = 'reversal' THEN
        IF NOT EXISTS (
          SELECT 1 FROM transactions original
          WHERE original.id = v_transaction.reversal_of AND original.status = 'posted'
        ) THEN
          RAISE EXCEPTION 'reversal % must refer to a posted transaction', v_transaction_id
            USING ERRCODE = '23514';
        END IF;
        IF EXISTS (
          (SELECT e.account_id,
              CASE e.direction WHEN 'debit' THEN 'credit'::entry_direction
                               ELSE 'debit'::entry_direction END AS direction,
              sum(e.amount_minor) AS amount_minor
           FROM entries e
           WHERE e.transaction_id = v_transaction.reversal_of
           GROUP BY e.account_id, direction
           EXCEPT
           SELECT e.account_id, e.direction, sum(e.amount_minor)
           FROM entries e
           WHERE e.transaction_id = v_transaction_id
           GROUP BY e.account_id, e.direction)
          UNION ALL
          (SELECT e.account_id, e.direction, sum(e.amount_minor)
           FROM entries e
           WHERE e.transaction_id = v_transaction_id
           GROUP BY e.account_id, e.direction
           EXCEPT
           SELECT e.account_id,
              CASE e.direction WHEN 'debit' THEN 'credit'::entry_direction
                               ELSE 'debit'::entry_direction END,
              sum(e.amount_minor)
           FROM entries e
           WHERE e.transaction_id = v_transaction.reversal_of
           GROUP BY e.account_id, direction)
        ) THEN
          RAISE EXCEPTION 'reversal % must exactly negate its original transaction', v_transaction_id
            USING ERRCODE = '23514';
        END IF;
      END IF;
      RETURN NULL;
    END;
    $$;

    CREATE CONSTRAINT TRIGGER transactions_must_balance
      AFTER INSERT OR UPDATE ON transactions
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION enforce_transaction_balance();
    CREATE CONSTRAINT TRIGGER entries_must_balance_transaction
      AFTER INSERT ON entries
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION enforce_transaction_balance();

    INSERT INTO accounts (account_code, display_name, currency, kind, type, allow_negative)
    SELECT
      definitions.code || '_' || currencies.currency,
      definitions.name,
      currencies.currency,
      'system',
      definitions.type::account_type,
      true
    FROM (VALUES
      ('provider_clearing', 'Provider clearing', 'asset'),
      ('fee_income', 'Fee income', 'income'),
      ('suspense', 'Suspense', 'liability')
    ) AS definitions(code, name, type)
    CROSS JOIN (VALUES ('NGN'), ('USD')) AS currencies(currency);
  `);
};

/** @type {import('node-pg-migrate').MigrationBuilder} */
exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE transaction_status_history;
    DROP TABLE entries;
    DROP TABLE account_balances;
    DROP TABLE transactions;
    DROP TABLE accounts;

    DROP FUNCTION enforce_transaction_balance();
    DROP FUNCTION record_transaction_status();
    DROP FUNCTION guard_transaction_update();
    DROP FUNCTION IF EXISTS reject_balance_projection_delete();
    DROP FUNCTION IF EXISTS enforce_nonnegative_customer_balance();
    DROP FUNCTION IF EXISTS enforce_balance_matches_journal();
    DROP FUNCTION reject_ledger_mutation();
    DROP FUNCTION validate_entry_insert();
    DROP FUNCTION guard_balance_projection();
    DROP FUNCTION guard_account_definition();
    DROP FUNCTION create_account_balance();

    DROP TYPE entry_direction;
    DROP TYPE ledger_transaction_status;
    DROP TYPE ledger_transaction_type;
    DROP TYPE account_status;
    DROP TYPE account_type;
    DROP TYPE account_kind;
  `);
};
