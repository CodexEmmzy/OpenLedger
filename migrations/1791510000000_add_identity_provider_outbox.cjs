/** @type {import('node-pg-migrate').MigrationBuilder} */
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE accounts ADD COLUMN owner_subject text;
    UPDATE accounts
    SET owner_subject = 'legacy-unassigned'
    WHERE kind = 'customer';
    ALTER TABLE accounts ADD CONSTRAINT accounts_owner_kind_check CHECK (
      (kind = 'system' AND owner_subject IS NULL)
      OR (kind = 'customer' AND owner_subject IS NOT NULL AND length(btrim(owner_subject)) > 0)
    );
    CREATE INDEX accounts_owner_subject_idx ON accounts (owner_subject, id)
      WHERE owner_subject IS NOT NULL;

    CREATE TYPE provider_payment_status AS ENUM
      ('pending', 'initialized', 'succeeded', 'failed', 'reconciliation_required');
    CREATE TABLE provider_payments (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      reference varchar(128) NOT NULL UNIQUE,
      idempotency_key varchar(128) NOT NULL UNIQUE
        CHECK (length(btrim(idempotency_key)) > 0),
      request_hash char(64) NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
      account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
      owner_subject text NOT NULL,
      amount_minor bigint NOT NULL CHECK (amount_minor > 0),
      currency char(3) NOT NULL CHECK (currency IN ('NGN', 'USD')),
      customer_email text NOT NULL CHECK (length(btrim(customer_email)) > 3),
      status provider_payment_status NOT NULL DEFAULT 'pending',
      authorization_url text,
      provider_reference text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CHECK (status <> 'initialized' OR authorization_url IS NOT NULL)
    );
    CREATE INDEX provider_payments_owner_created_idx
      ON provider_payments (owner_subject, created_at DESC);

    CREATE TYPE provider_event_status AS ENUM ('received', 'reconciled', 'rejected');
    CREATE TABLE provider_events (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      provider text NOT NULL CHECK (provider = 'paystack'),
      event_key text NOT NULL,
      event_type text NOT NULL,
      reference varchar(128) NOT NULL,
      amount_minor bigint NOT NULL CHECK (amount_minor > 0),
      currency char(3) NOT NULL CHECK (currency IN ('NGN', 'USD')),
      payload_hash char(64) NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
      status provider_event_status NOT NULL DEFAULT 'received',
      received_at timestamptz NOT NULL DEFAULT now(),
      processed_at timestamptz,
      UNIQUE (provider, event_key)
    );

    CREATE TYPE outbox_status AS ENUM ('pending', 'processing', 'completed', 'dead');
    CREATE TABLE outbox_events (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      event_type text NOT NULL,
      aggregate_id uuid NOT NULL,
      payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
      status outbox_status NOT NULL DEFAULT 'pending',
      attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      available_at timestamptz NOT NULL DEFAULT now(),
      locked_at timestamptz,
      lock_owner text,
      last_error text,
      created_at timestamptz NOT NULL DEFAULT now(),
      completed_at timestamptz,
      CHECK ((status = 'processing') = (locked_at IS NOT NULL AND lock_owner IS NOT NULL)),
      CHECK ((status = 'completed') = (completed_at IS NOT NULL))
    );
    CREATE INDEX outbox_claim_idx ON outbox_events (available_at, id)
      WHERE status = 'pending';

    CREATE FUNCTION guard_provider_payment_update() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      IF OLD.id IS DISTINCT FROM NEW.id
        OR OLD.reference IS DISTINCT FROM NEW.reference
        OR OLD.account_id IS DISTINCT FROM NEW.account_id
        OR OLD.owner_subject IS DISTINCT FROM NEW.owner_subject
        OR OLD.amount_minor IS DISTINCT FROM NEW.amount_minor
        OR OLD.currency IS DISTINCT FROM NEW.currency
        OR OLD.customer_email IS DISTINCT FROM NEW.customer_email
        OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
        RAISE EXCEPTION 'provider payment identity is immutable'
          USING ERRCODE = '55000';
      END IF;
      IF OLD.status IS DISTINCT FROM NEW.status THEN
        IF NOT (
          (OLD.status = 'pending' AND NEW.status IN ('initialized', 'succeeded', 'failed', 'reconciliation_required'))
          OR (OLD.status = 'initialized' AND NEW.status IN ('succeeded', 'failed', 'reconciliation_required'))
        ) THEN
          RAISE EXCEPTION 'provider payment status transition is not allowed'
            USING ERRCODE = '23514';
        END IF;
      END IF;
      NEW.updated_at := now();
      RETURN NEW;
    END;
    $$;
    CREATE TRIGGER provider_payments_guard_update
      BEFORE UPDATE ON provider_payments
      FOR EACH ROW EXECUTE FUNCTION guard_provider_payment_update();

    CREATE FUNCTION guard_provider_event_mutation() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      IF OLD.provider IS DISTINCT FROM NEW.provider
        OR OLD.event_key IS DISTINCT FROM NEW.event_key
        OR OLD.event_type IS DISTINCT FROM NEW.event_type
        OR OLD.reference IS DISTINCT FROM NEW.reference
        OR OLD.amount_minor IS DISTINCT FROM NEW.amount_minor
        OR OLD.currency IS DISTINCT FROM NEW.currency
        OR OLD.payload_hash IS DISTINCT FROM NEW.payload_hash
        OR OLD.received_at IS DISTINCT FROM NEW.received_at THEN
        RAISE EXCEPTION 'provider event identity is immutable'
          USING ERRCODE = '55000';
      END IF;
      IF OLD.status IS DISTINCT FROM NEW.status
        AND NOT (OLD.status = 'received' AND NEW.status IN ('reconciled', 'rejected')) THEN
        RAISE EXCEPTION 'provider event status can only move forward from received'
          USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END;
    $$;
    CREATE TRIGGER provider_events_guard_update
      BEFORE UPDATE ON provider_events
      FOR EACH ROW EXECUTE FUNCTION guard_provider_event_mutation();
    CREATE TRIGGER provider_events_no_delete
      BEFORE DELETE OR TRUNCATE ON provider_events
      FOR EACH STATEMENT EXECUTE FUNCTION reject_ledger_mutation();
  `);
};

/** @type {import('node-pg-migrate').MigrationBuilder} */
exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE outbox_events;
    DROP TABLE provider_events;
    DROP TABLE provider_payments;
    DROP FUNCTION guard_provider_event_mutation();
    DROP FUNCTION guard_provider_payment_update();
    DROP TYPE outbox_status;
    DROP TYPE provider_event_status;
    DROP TYPE provider_payment_status;
    DROP INDEX accounts_owner_subject_idx;
    ALTER TABLE accounts DROP CONSTRAINT accounts_owner_kind_check;
    ALTER TABLE accounts DROP COLUMN owner_subject;
  `);
};
