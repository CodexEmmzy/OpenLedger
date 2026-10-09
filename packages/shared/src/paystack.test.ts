import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { initializePaystackPayment, verifyPaystackSignature } from './paystack.js';

describe('Paystack adapter', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('initializes with exact minor units, currency, and stable reference', async () => {
    const fetchMock = vi.fn(async (_url: URL, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({ authorization: 'Bearer sk_test_local' });
      expect(JSON.parse(String(init?.body))).toMatchObject({
        amount: 12345,
        currency: 'NGN',
        reference: 'deposit-reference-1',
      });
      return new Response(
        JSON.stringify({
          status: true,
          data: {
            authorization_url: 'https://checkout.paystack.com/authorize/1',
            reference: 'deposit-reference-1',
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await initializePaystackPayment(
      { secretKey: 'sk_test_local', baseUrl: 'https://api.paystack.test' },
      {
        email: 'customer@example.test',
        amountMinor: 12345n,
        currency: 'NGN',
        reference: 'deposit-reference-1',
        accountId: 'account-id',
      },
    );
    expect(result.providerReference).toBe('deposit-reference-1');
    expect(result.authorizationUrl).toBe('https://checkout.paystack.com/authorize/1');
  });

  it('rejects Paystack amounts outside the exact JSON integer range', async () => {
    await expect(
      initializePaystackPayment(
        { secretKey: 'sk_test_local', baseUrl: 'https://api.paystack.test' },
        {
          email: 'customer@example.test',
          amountMinor: BigInt(Number.MAX_SAFE_INTEGER) + 1n,
          currency: 'NGN',
          reference: 'deposit-reference-2',
          accountId: 'account-id',
        },
      ),
    ).rejects.toThrow(/safe integer/);
  });

  it('verifies signatures against the exact raw bytes', () => {
    const rawBody = Buffer.from('{"event":"charge.success"}');
    const secret = 'webhook-secret';
    const signature = createHmac('sha512', secret).update(rawBody).digest('hex');
    expect(verifyPaystackSignature(secret, rawBody, signature)).toBe(true);
    expect(
      verifyPaystackSignature(secret, Buffer.from('{"event":"charge.failed"}'), signature),
    ).toBe(false);
    expect(verifyPaystackSignature(secret, rawBody, 'not-a-signature')).toBe(false);
  });
});
