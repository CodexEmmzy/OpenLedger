-- Run as a PostgreSQL administrator for a new deployment, not as the application.
-- Create separate LOGIN roles and grant membership in these groups through the
-- secret-management/deployment system. Do not put passwords in this file.

CREATE ROLE openledger_api_runtime NOLOGIN;
CREATE ROLE openledger_worker_runtime NOLOGIN;
CREATE ROLE openledger_migrator NOLOGIN;

GRANT USAGE ON SCHEMA public
  TO openledger_api_runtime, openledger_worker_runtime, openledger_migrator;

GRANT SELECT, INSERT ON accounts TO openledger_api_runtime;
GRANT SELECT ON accounts TO openledger_worker_runtime;

GRANT SELECT, INSERT, UPDATE ON account_balances TO openledger_api_runtime;
GRANT SELECT, INSERT, UPDATE ON transactions TO openledger_api_runtime;
GRANT SELECT, INSERT ON entries TO openledger_api_runtime;
GRANT SELECT ON transaction_status_history TO openledger_api_runtime;
GRANT SELECT, INSERT ON provider_payments TO openledger_api_runtime;
GRANT SELECT, INSERT ON provider_events TO openledger_api_runtime;
GRANT SELECT, INSERT ON outbox_events TO openledger_api_runtime;

GRANT SELECT, INSERT, UPDATE ON account_balances TO openledger_worker_runtime;
GRANT SELECT, INSERT, UPDATE ON transactions TO openledger_worker_runtime;
GRANT SELECT, INSERT ON entries TO openledger_worker_runtime;
GRANT SELECT ON transaction_status_history TO openledger_worker_runtime;
GRANT SELECT, UPDATE ON provider_payments TO openledger_worker_runtime;
GRANT SELECT, UPDATE ON provider_events TO openledger_worker_runtime;
GRANT SELECT, UPDATE ON outbox_events TO openledger_worker_runtime;

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public
  TO openledger_api_runtime, openledger_worker_runtime, openledger_migrator;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public
  TO openledger_migrator;

-- Provisioning example (execute separately with secret-manager supplied passwords):
-- CREATE ROLE openledger_api LOGIN INHERIT;
-- GRANT openledger_api_runtime TO openledger_api;
-- CREATE ROLE openledger_worker LOGIN INHERIT;
-- GRANT openledger_worker_runtime TO openledger_worker;
-- CREATE ROLE openledger_migration LOGIN INHERIT;
-- GRANT openledger_migrator TO openledger_migration;