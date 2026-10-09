import pg from 'pg';
import { assertLedgerInvariants } from '../api/src/modules/ledger/ledger-repository.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error('DATABASE_URL is required');
}

const pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
try {
  const report = await assertLedgerInvariants(pool);
  console.log(JSON.stringify(report, null, 2));
} finally {
  await pool.end();
}
