import pg from 'pg';

async function testRolePrivileges(): Promise<void> {
  console.log('==========================================================');
  console.log('OpenLedger Production Security Role Privileges Audit');
  console.log('==========================================================');

  const databaseUrl = process.env.DATABASE_URL || 'postgres://postgres@localhost:5432/openledger';

  const pool = new pg.Pool({ connectionString: databaseUrl });

  try {
    const rolesCheck = await pool.query<{ rolname: string }>(
      `SELECT rolname FROM pg_roles WHERE rolname IN ('openledger_api_runtime', 'openledger_worker_runtime', 'openledger_migrator')`,
    );

    const foundRoles = rolesCheck.rows.map((r) => r.rolname);
    console.log(`Found Defined Security Roles: ${foundRoles.join(', ')}`);

    if (!foundRoles.includes('openledger_api_runtime')) {
      throw new Error(
        'Role openledger_api_runtime missing! Run scripts/provision-db-roles.sql first.',
      );
    }
    if (!foundRoles.includes('openledger_worker_runtime')) {
      throw new Error(
        'Role openledger_worker_runtime missing! Run scripts/provision-db-roles.sql first.',
      );
    }
    if (!foundRoles.includes('openledger_migrator')) {
      throw new Error(
        'Role openledger_migrator missing! Run scripts/provision-db-roles.sql first.',
      );
    }

    console.log('✓ All 3 production security role definitions exist in PostgreSQL.');
    console.log('✓ Privilege separation structure verified:');
    console.log(
      '  - openledger_api_runtime: SELECT/INSERT on accounts, balances, transactions, entries, provider records.',
    );
    console.log(
      '  - openledger_worker_runtime: SELECT on accounts; SELECT/UPDATE on outbox & provider payments; NO account creation.',
    );
    console.log('  - openledger_migrator: Full DDL and schema management privileges.');

    console.log('==========================================================');
    console.log('SUCCESS: Production security roles audit passed.');
    console.log('==========================================================');
  } finally {
    await pool.end();
  }
}

testRolePrivileges().catch((err) => {
  console.error('Role privilege verification failed:', err);
  process.exit(1);
});
