import https from 'node:https';

interface PaystackVerifyResponse {
  status: boolean;
  message: string;
  data?: Record<string, unknown>;
}

async function verifyPaystackCredentials(): Promise<void> {
  const secretKey = process.env.PAYSTACK_SECRET_KEY;
  const isMock = process.env.PAYSTACK_MOCK_VERIFY === 'true';

  console.log('==========================================================');
  console.log('OpenLedger Paystack Credential & Operational Verifier');
  console.log('==========================================================');

  if (isMock) {
    console.log('[MOCK MODE] Simulating Paystack Sandbox credential verification...');
    console.log('✓ Credential Prefix: sk_test_mock_verified');
    console.log('✓ Environment: Sandbox / Integration');
    console.log('✓ API Connectivity: HTTP 200 OK');
    console.log('✓ Webhook Secret: Configured');
    console.log('Status: PAYSTACK CREDENTIALS VERIFIED (MOCK)');
    return;
  }

  if (!secretKey) {
    console.error('ERROR: PAYSTACK_SECRET_KEY environment variable is not set.');
    console.error(
      'Set PAYSTACK_SECRET_KEY or set PAYSTACK_MOCK_VERIFY=true for local mock verification.',
    );
    process.exit(1);
  }

  const isLive = secretKey.startsWith('sk_live_');
  const isTest = secretKey.startsWith('sk_test_');

  if (!isLive && !isTest) {
    console.error('ERROR: PAYSTACK_SECRET_KEY must start with sk_test_ or sk_live_.');
    process.exit(1);
  }

  const envType = isLive ? 'PRODUCTION / LIVE' : 'SANDBOX / TEST';
  console.log(`Detected Credential Environment: ${envType}`);
  console.log('Connecting to Paystack API (https://api.paystack.co/balance)...');

  return new Promise((resolve, reject) => {
    const req = https.request(
      'https://api.paystack.co/balance',
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${secretKey}`,
          'Content-Type': 'application/json',
        },
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => {
          body += chunk;
        });

        res.on('end', () => {
          try {
            if (res.statusCode === 200) {
              const parsed = JSON.parse(body) as PaystackVerifyResponse;
              console.log(`✓ Paystack API Response: ${parsed.message || 'Success'}`);
              console.log('✓ Secret key is valid and authorized.');
              console.log(
                `Status: PAYSTACK ${isLive ? 'LIVE' : 'SANDBOX'} CREDENTIALS VERIFIED OK`,
              );
              resolve();
            } else if (res.statusCode === 401) {
              console.error('× Authentication Failed: Invalid secret key or unauthorized.');
              process.exit(1);
            } else {
              console.warn(`! Paystack API returned HTTP ${res.statusCode}: ${body}`);
              resolve();
            }
          } catch (err) {
            console.error('Failed to parse Paystack response:', err);
            reject(err);
          }
        });
      },
    );

    req.on('error', (err) => {
      console.error('Failed to connect to Paystack API:', err.message);
      reject(err);
    });

    req.end();
  });
}

verifyPaystackCredentials().catch((err) => {
  console.error('Verification failed:', err);
  process.exit(1);
});
