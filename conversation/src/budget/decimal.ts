const TEN = 10n;

const DECIMAL_PATTERN = /^([+-])?(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/;

function powerOfTen(exponent: number): bigint {
	return TEN ** BigInt(exponent);
}

/**
 * Exact base-10 decimal for money. The value is `units / 10^scale` and the
 * scale is preserved through addition and formatting, the way Python's
 * `Decimal` preserves it, so ledger strings round-trip unchanged.
 */
export class Decimal {
	readonly units: bigint;
	readonly scale: number;

	private constructor(units: bigint, scale: number) {
		this.units = units;
		this.scale = scale;
	}

	static parse(text: string): Decimal {
		const match = DECIMAL_PATTERN.exec(text.trim());
		if (match === null) {
			throw new Error(`Not a decimal number: ${JSON.stringify(text)}`);
		}
		const [, sign, whole = "", fraction = "", exponentText] = match;
		const digits = `${whole}${fraction}`;
		if (digits.length === 0) {
			throw new Error(`Not a decimal number: ${JSON.stringify(text)}`);
		}
		let units = BigInt(digits);
		let scale = fraction.length - (exponentText === undefined ? 0 : Number(exponentText));
		if (scale < 0) {
			units *= powerOfTen(-scale);
			scale = 0;
		}
		return new Decimal(sign === "-" ? -units : units, scale);
	}

	static zero(): Decimal {
		return new Decimal(0n, 0);
	}

	add(other: Decimal): Decimal {
		const scale = Math.max(this.scale, other.scale);
		return new Decimal(this.alignedTo(scale) + other.alignedTo(scale), scale);
	}

	multiplyByInteger(factor: number): Decimal {
		return new Decimal(this.units * BigInt(factor), this.scale);
	}

	divideByPowerOfTen(exponent: number): Decimal {
		return new Decimal(this.units, this.scale + exponent);
	}

	/** Round half to even at `scale` fraction digits, like Python `quantize`. */
	quantize(scale: number): Decimal {
		if (scale >= this.scale) {
			return new Decimal(this.alignedTo(scale), scale);
		}
		const divisor = powerOfTen(this.scale - scale);
		const negative = this.units < 0n;
		const magnitude = negative ? -this.units : this.units;
		let quotient = magnitude / divisor;
		const remainder = magnitude % divisor;
		const doubled = remainder * 2n;
		if (doubled > divisor || (doubled === divisor && quotient % 2n === 1n)) {
			quotient += 1n;
		}
		return new Decimal(negative ? -quotient : quotient, scale);
	}

	compare(other: Decimal): -1 | 0 | 1 {
		const scale = Math.max(this.scale, other.scale);
		const left = this.alignedTo(scale);
		const right = other.alignedTo(scale);
		if (left === right) {
			return 0;
		}
		return left < right ? -1 : 1;
	}

	equals(other: Decimal): boolean {
		return this.compare(other) === 0;
	}

	isPositive(): boolean {
		return this.units > 0n;
	}

	toString(): string {
		const negative = this.units < 0n;
		const digits = (negative ? -this.units : this.units).toString().padStart(this.scale + 1, "0");
		const whole = digits.slice(0, digits.length - this.scale);
		const fraction = digits.slice(digits.length - this.scale);
		const body = this.scale === 0 ? whole : `${whole}.${fraction}`;
		return negative ? `-${body}` : body;
	}

	private alignedTo(scale: number): bigint {
		return this.units * powerOfTen(scale - this.scale);
	}
}
