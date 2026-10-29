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

/** The authorization as the SRI returns it: what the authorized XML is made of */
export interface AuthorizedVoucher {
  number: string;
  // fechaAutorizacion in ISO 8601: as the SRI wrote it, or in UTC when the SOAP client parsed it
  date: string;
  // ambiente: PRUEBAS or PRODUCCIÓN
  environment: string;
  // comprobante: the signed XML the SRI authorized
  voucherXml: string;
}

export class AuthorizationVoucher {
  constructor(
    public readonly status: AuthorizationVoucherStatus,
    public readonly code: string | null,
    public readonly authorizationDate: Date | null,
    public readonly messages: string[] = [],
    // Only when authorized and the SRI sent the number and the voucher
    public readonly authorized: AuthorizedVoucher | null = null,
  ) {}
}
