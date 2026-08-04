/**
 * USDC amounts as exact integers.
 *
 * USDC has six decimal places, and every amount here is held as a bigint count
 * of micro-units (1 USDC = 1_000_000). No floats touch money at any point:
 * `0.1 + 0.2 !== 0.3` is a curiosity in a report and a defect in a payment
 * system, and comparisons against a spend cap are exactly where it would bite.
 *
 * Deliberately tiny and dependency-free rather than pulling in a general
 * decimal library — the only operations this system performs on money are
 * add and compare.
 */

const SCALE = 6n;
const UNIT = 10n ** SCALE;

export class Decimal {
  /** Micro-units. 1 USDC === 1_000_000n. */
  readonly micro: bigint;

  constructor(value: string | number | bigint | Decimal) {
    if (value instanceof Decimal) {
      this.micro = value.micro;
      return;
    }
    if (typeof value === 'bigint') {
      this.micro = value;
      return;
    }
    this.micro = Decimal.parse(String(value));
  }

  /** Construct directly from micro-units, e.g. from an on-chain amount. */
  static fromMicro(micro: bigint | string): Decimal {
    return new Decimal(typeof micro === 'string' ? BigInt(micro) : micro);
  }

  private static parse(raw: string): bigint {
    const text = raw.trim();
    if (!/^-?\d+(\.\d+)?$/.test(text)) {
      throw new TypeError(`not a decimal amount: ${JSON.stringify(raw)}`);
    }
    const negative = text.startsWith('-');
    const digits = negative ? text.slice(1) : text;
    const dot = digits.indexOf('.');
    // Explicit rather than destructured: the regex above guarantees a whole
    // part, but `noUncheckedIndexedAccess` is right not to take our word for it.
    const whole = dot === -1 ? digits : digits.slice(0, dot);
    const fraction = dot === -1 ? '' : digits.slice(dot + 1);
    if (fraction.length > Number(SCALE)) {
      // Truncating here would silently round someone's money. USDC cannot
      // represent it, so the caller has to decide what they meant.
      throw new RangeError(
        `${raw} has more than ${SCALE} decimal places, which USDC cannot represent`,
      );
    }
    const padded = fraction.padEnd(Number(SCALE), '0');
    const micro = BigInt(whole) * UNIT + BigInt(padded || '0');
    return negative ? -micro : micro;
  }

  plus(other: Decimal | string | number): Decimal {
    return new Decimal(this.micro + new Decimal(other).micro);
  }

  minus(other: Decimal | string | number): Decimal {
    return new Decimal(this.micro - new Decimal(other).micro);
  }

  gt(other: Decimal | string | number): boolean {
    return this.micro > new Decimal(other).micro;
  }

  gte(other: Decimal | string | number): boolean {
    return this.micro >= new Decimal(other).micro;
  }

  lte(other: Decimal | string | number): boolean {
    return this.micro <= new Decimal(other).micro;
  }

  isPositive(): boolean {
    return this.micro > 0n;
  }

  /** Canonical decimal string, trailing zeros trimmed but never the point's value. */
  toString(): string {
    const negative = this.micro < 0n;
    const abs = negative ? -this.micro : this.micro;
    const whole = abs / UNIT;
    const fraction = (abs % UNIT).toString().padStart(Number(SCALE), '0').replace(/0+$/, '');
    const body = fraction ? `${whole}.${fraction}` : `${whole}`;
    return negative ? `-${body}` : body;
  }

  toJSON(): string {
    return this.toString();
  }
}

export const USDC = (value: string | number): Decimal => new Decimal(value);
