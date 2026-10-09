import http from 'k6/http';
import { check } from 'k6';

const accountIds = JSON.parse(__ENV.ACCOUNT_IDS || '[]');
const runId = __ENV.LOAD_RUN_ID;

if (!__ENV.OPENLEDGER_TOKEN || !runId || accountIds.length < 2) {
  throw new Error(
    'Set OPENLEDGER_TOKEN, LOAD_RUN_ID, and ACCOUNT_IDS with at least two funded test accounts.',
  );
}

export const options = {
  scenarios: {
    transfers: {
      executor: 'ramping-arrival-rate',
      startRate: 50,
      timeUnit: '1s',
      preAllocatedVUs: 200,
      maxVUs: 4000,
      stages: [
        { target: 150, duration: '2m' },
        { target: 1500, duration: '5m' },
        { target: 1500, duration: '10m' },
        { target: 50, duration: '2m' },
      ],
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.001'],
    http_req_duration: ['p(99)<200'],
    checks: ['rate>0.999'],
  },
};

export default function () {
  const sourceIndex = (__VU + __ITER) % accountIds.length;
  let destinationIndex = (__VU * 7 + __ITER + 1) % accountIds.length;
  if (destinationIndex === sourceIndex) {
    destinationIndex = (destinationIndex + 1) % accountIds.length;
  }

  const response = http.post(
    `${__ENV.OPENLEDGER_BASE_URL}/v1/transfers`,
    JSON.stringify({
      sourceAccountId: accountIds[sourceIndex],
      destinationAccountId: accountIds[destinationIndex],
      amountMinor: 1,
      currency: __ENV.CURRENCY || 'NGN',
    }),
    {
      headers: {
        authorization: `Bearer ${__ENV.OPENLEDGER_TOKEN}`,
        'content-type': 'application/json',
        'idempotency-key': `${runId}-${__VU}-${__ITER}`,
      },
    },
  );

  check(response, {
    'transfer committed or idempotent result returned': (result) =>
      result.status === 201 || result.status === 200,
  });
}
