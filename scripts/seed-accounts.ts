import pg from 'pg';

const DEFAULT_COUNT = 10_000;
const MAX_COUNT = 1_000_000;
const currencies = new Set(['NGN', 'USD']);

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error('DATABASE_URL is required');
}

const count = readIntegerArgument('--count', DEFAULT_COUNT);
if (count < 1 || count > MAX_COUNT) {
  throw new Error(`--count must be between 1 and ${MAX_COUNT}`);
}

const currency = readStringArgument('--currency', 'NGN').toUpperCase();
if (!currencies.has(currency)) {
  throw new Error('--currency must be NGN or USD');
}

const pool = new pg.Pool({ connectionString: databaseUrl });

try {
  const result = await pool.query(
    `INSERT INTO accounts (external_ref, display_name, currency, kind, type)
     SELECT
       'loadtest:' || $2 || ':' || generated.account_number,
       'Load test wallet ' || generated.account_number,
       $2,
       'customer',
       'liability'
     FROM generate_series(1, $1) AS generated(account_number)
     ON CONFLICT (external_ref) DO NOTHING`,
    [count, currency],
  );
  console.log(`Created ${result.rowCount ?? 0} ${currency} load-test accounts.`);
} finally {
  await pool.end();
}

function readIntegerArgument(name: string, fallback: number): number {
  const argument = process.argv.find((value) => value.startsWith(`${name}=`));
  if (!argument) {
    return fallback;
  }
  const value = Number(argument.slice(name.length + 1));
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${name} must be an integer`);
  }
  return value;
}

function readStringArgument(name: string, fallback: string): string {
  const argument = process.argv.find((value) => value.startsWith(`${name}=`));
  return argument ? argument.slice(name.length + 1) : fallback;
}
