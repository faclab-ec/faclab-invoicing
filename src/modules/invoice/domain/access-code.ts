import { Environment } from '#/modules/company-config/domain/company-config';

export class AccessCode {
  private static readonly PATTERN = /^\d{49}$/;

  private constructor(public readonly value: string) {}

  static create(value: string): AccessCode {
    if (!AccessCode.PATTERN.test(value)) {
      throw new Error(`Invalid access code: must be exactly 49 digits, got "${value}"`);
    }
    return new AccessCode(value);
  }

  /** The SRI environment it was issued for: digit 24, after the date, the type and the RUC */
  get environment(): Environment {
    return Number(this.value[23]) as Environment;
  }

  toString(): string {
    return this.value;
  }

  equals(other: AccessCode): boolean {
    return this.value === other.value;
  }
}
