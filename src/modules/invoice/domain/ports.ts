import { Environment } from '#/modules/company-config/domain/company-config';

import { AuthorizationVoucher, ValidationVoucher } from './voucher';

export interface InvoiceSignerPort {
  /** Signs with the certificate of the company's issuer */
  signInvoice(xml: string, tenantId: string): Promise<string>;
}

export interface MessageProducer<T> {
  sendMessage(message: T): Promise<void>;
}

// Each call goes to the SRI web services of the invoice's environment
export interface SriValidationPort {
  validateXml(xml: string, environment: Environment): Promise<ValidationVoucher>;
}

export interface SriAuthorizationPort {
  authorizeXml(code: string, environment: Environment): Promise<AuthorizationVoucher>;
}
