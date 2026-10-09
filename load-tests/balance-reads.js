import http from 'k6/http';
import { check } from 'k6';

const accountIds = JSON.parse(__ENV.ACCOUNT_IDS || '[]');

if (!__ENV.OPENLEDGER_TOKEN || accountIds.length === 0) {
  throw new Error('Set OPENLEDGER_TOKEN and ACCOUNT_IDS with owned test accounts.');
}

export const options = {
  vus: Number(__ENV.VUS || 500),
  duration: __ENV.DURATION || '10m',
  thresholds: {
    http_req_failed: ['rate<0.001'],
    http_req_duration: ['p(99)<50'],
    checks: ['rate>0.999'],
  },
};

export default function () {
  const accountId = accountIds[(__VU + __ITER) % accountIds.length];
  const response = http.get(`${__ENV.OPENLEDGER_BASE_URL}/v1/accounts/${accountId}/balance`, {
    headers: { authorization: `Bearer ${__ENV.OPENLEDGER_TOKEN}` },
  });
  check(response, {
    'balance read succeeds': (result) => result.status === 200,
    'balance is represented exactly': (result) => {
      const amount = result.json('amountMinor');
      return Number.isSafeInteger(amount) || (typeof amount === 'string' && /^\d+$/.test(amount));
    },
  });
}
