import { Environment } from '#/modules/company-config/domain/company-config';

import { Ride } from './ride';
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

/** Object storage for the documents kept for each company (authorized XML, RIDE, issuer logo) */
export interface DocumentStorage {
  put(key: string, body: string | Buffer, contentType: string): Promise<void>;
  /** As text (the XML); null when there is nothing under the key */
  get(key: string): Promise<string | null>;
  /** As bytes (the RIDE, the logo); null when there is nothing under the key */
  getBytes(key: string): Promise<Buffer | null>;
  /** Removes what is under the key, if anything */
  delete(key: string): Promise<void>;
}

/** Draws the RIDE as a PDF, with the issuer's logo when it has one */
export interface RideRenderer {
  render(ride: Ride, logo: Buffer | null): Promise<Buffer>;
}

export interface MailAttachment {
  filename: string;
  content: Buffer;
  contentType: string;
}

/** An email with the invoice to its buyer */
export interface OutgoingMail {
  from: { name: string; address: string };
  replyTo: string | null;
  to: string;
  subject: string;
  text: string;
  html: string;
  attachments: MailAttachment[];
}

export interface SentMail {
  messageId: string;
  // What the mail server answered (250 …)
  response: string;
}

/** Sends emails through the mail server (SMTP, D-3) */
export interface InvoiceMailer {
  /**
   * Throws MailRejectedError when the server refuses it for good; anything else it throws may go
   * through later
   */
  send(mail: OutgoingMail): Promise<SentMail>;
  close(): void;
}

/** The mail server refused the message or its recipient for good (5xx): a bounce */
export class MailRejectedError extends Error {
  constructor(public readonly response: string) {
    super('The mail server refused the message');
    this.name = 'MailRejectedError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
