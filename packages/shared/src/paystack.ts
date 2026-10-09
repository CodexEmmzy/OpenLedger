import { createHmac, timingSafeEqual } from 'node:crypto';

export interface PaystackConfig {
  secretKey: string;
  baseUrl: string;
}

export interface PaystackInitializationInput {
  email: string;
  amountMinor: bigint;
  currency: string;
  reference: string;
  accountId: string;
}

export interface PaystackInitializationResult {
  authorizationUrl: string;
  providerReference: string;
}

interface PaystackEnvelope<T> {
  status: boolean;
  data?: T;
}

interface PaystackInitializationData {
  authorization_url?: unknown;
  reference?: unknown;
}

export async function initializePaystackPayment(
  config: PaystackConfig,
  input: PaystackInitializationInput,
): Promise<PaystackInitializationResult> {
  if (input.amountMinor <= 0n || input.amountMinor > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('Paystack amount must fit the supported safe integer minor-unit range');
  }
  const response = await fetch(new URL('/transaction/initialize', config.baseUrl), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${config.secretKey}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({
      email: input.email,
      amount: Number(input.amountMinor),
      currency: input.currency,
      reference: input.reference,
      metadata: { accountId: input.accountId },
    }),
    signal: AbortSignal.timeout(10_000),
  });

  const envelope = (await response
    .json()
    .catch(() => null)) as PaystackEnvelope<PaystackInitializationData> | null;
  if (!response.ok || !envelope?.status || !envelope.data) {
    throw new Error(`Paystack initialization failed with status ${response.status}`);
  }
  if (
    typeof envelope.data.authorization_url !== 'string' ||
    typeof envelope.data.reference !== 'string' ||
    envelope.data.reference !== input.reference
  ) {
    throw new Error('Paystack returned an invalid initialization response');
  }
  const authorizationUrl = new URL(envelope.data.authorization_url);
  if (
    authorizationUrl.protocol !== 'https:' ||
    (authorizationUrl.hostname !== 'paystack.com' && !authorizationUrl.hostname.endsWith('.paystack.com'))
  ) {
    throw new Error('Paystack returned a checkout URL outside its trusted HTTPS domain');
  }
  return {
    authorizationUrl: authorizationUrl.toString(),
    providerReference: envelope.data.reference,
  };
}

export function verifyPaystackSignature(
  secretKey: string,
  rawBody: Buffer,
  signature: string | undefined,
): boolean {
  if (!signature || !/^[0-9a-f]{128}$/i.test(signature)) {
    return false;
  }
  const expected = createHmac('sha512', secretKey).update(rawBody).digest();
  const received = Buffer.from(signature, 'hex');
  return received.length === expected.length && timingSafeEqual(received, expected);
}

export interface PaystackVerifiedTransaction {
  reference: string;
  status: 'success';
  amountMinor: bigint;
  currency: string;
}

interface PaystackVerificationData {
  reference?: unknown;
  status?: unknown;
  amount?: unknown;
  currency?: unknown;
}

export async function verifyPaystackTransaction(
  config: PaystackConfig,
  reference: string,
): Promise<PaystackVerifiedTransaction> {
  const response = await fetch(
    new URL(`/transaction/verify/${encodeURIComponent(reference)}`, config.baseUrl),
    {
      method: 'GET',
      headers: {
        authorization: `Bearer ${config.secretKey}`,
        accept: 'application/json',
      },
      signal: AbortSignal.timeout(10_000),
    },
  );
  const envelope = (await response
    .json()
    .catch(() => null)) as PaystackEnvelope<PaystackVerificationData> | null;
  const data = envelope?.data;
  if (
    !response.ok ||
    !envelope?.status ||
    !data ||
    data.reference !== reference ||
    data.status !== 'success' ||
    !Number.isSafeInteger(data.amount) ||
    Number(data.amount) <= 0 ||
    typeof data.currency !== 'string'
  ) {
    throw new Error(`Paystack verification failed for reference ${reference}`);
  }
  return {
    reference,
    status: 'success',
    amountMinor: BigInt(Number(data.amount)),
    currency: data.currency,
  };
}
