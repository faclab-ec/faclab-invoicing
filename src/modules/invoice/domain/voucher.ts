export enum ValidationVoucherStatus {
  ACCEPTED = 'ACCEPTED',
  REJECTED = 'REJECTED',
}

export enum AuthorizationVoucherStatus {
  AUTHORIZED = 'AUTHORIZED',
  REJECTED = 'REJECTED',
  // No decision yet (no authorization returned, or "EN PROCESO")
  PROCESSING = 'PROCESSING',
}

export class ValidationVoucher {
  constructor(
    public readonly status: ValidationVoucherStatus,
    public readonly code: string | null,
    public readonly messages: string[] = [],
    // Returned (DEVUELTA) only because the SRI already has this access code
    public readonly alreadyReceived: boolean = false,
  ) {}
}

export class AuthorizationVoucher {
  constructor(
    public readonly status: AuthorizationVoucherStatus,
    public readonly code: string | null,
    public readonly authorizationDate: Date | null,
    public readonly messages: string[] = [],
  ) {}
}
