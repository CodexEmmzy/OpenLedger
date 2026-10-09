/** Integer minor units (kobo, cents). Never a float. */
export type MinorUnits = bigint;

const INTEGER_PATTERN = /^-?\d+$/;

export function parseMinorUnits(value: string | number | bigint): MinorUnits {
  if (typeof value === 'bigint') {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) {
      throw new Error('money must be integer minor units; floats are forbidden');
    }
    return BigInt(value);
  }
  const trimmed = value.trim();
  if (!INTEGER_PATTERN.test(trimmed)) {
    throw new Error('money must be a base-10 integer string of minor units');
  }
  return BigInt(trimmed);
}

export function formatMinorUnits(value: MinorUnits): string {
  return value.toString(10);
}

export function addMinorUnits(left: MinorUnits, right: MinorUnits): MinorUnits {
  return left + right;
}

export function assertNonNegative(value: MinorUnits, label = 'amount'): void {
  if (value < 0n) {
    throw new Error(`${label} must be >= 0`);
  }
}
