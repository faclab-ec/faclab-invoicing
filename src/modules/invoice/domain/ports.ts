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

export interface SchemaValidationResult {
  valid: boolean;
  // What the schema rejected, one entry per problem
  errors: string[];
}

/** Checks an invoice XML against the SRI schema (XSD) before it is signed */
export interface InvoiceSchemaValidator {
  validate(xml: string): Promise<SchemaValidationResult>;
}

/** Object storage for the documents kept for each company (the authorized XML) */
export interface DocumentStorage {
  put(key: string, body: string, contentType: string): Promise<void>;
  /** Null when there is nothing under the key */
  get(key: string): Promise<string | null>;
}
