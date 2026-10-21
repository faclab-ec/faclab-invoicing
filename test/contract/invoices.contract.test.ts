import Ajv2020 from 'ajv/dist/2020';
import { describe, expect, it } from 'vitest';

import { AccessCode } from '#/modules/invoice/domain/access-code';
import { InvoiceDomainEvent } from '#/modules/invoice/domain/events';
import { Invoice } from '#/modules/invoice/domain/invoice';
import { toInvoiceMessage } from '#/modules/invoice/infra/messaging/invoice-message';
import { InvoiceMessageSchema } from '#/modules/invoice/infra/messaging/schemas';

import { makePoint, makeSale, TENANT_A } from '../helpers';
import { loadExamples, loadSchema } from './contracts';

const validate = new Ajv2020({ allErrors: true }).compile(loadSchema('invoices'));
const examples = loadExamples('invoices');

/** Every transition an invoice publishes, from received to authorized or rejected */
function publishedEvents(): InvoiceDomainEvent[] {
  const accessCode = AccessCode.create('1'.repeat(49));
  const authorized = Invoice.receive(
    '9c5cc2d1-cb98-5f3b-bcc0-51abf102c37a',
    makePoint(),
    makeSale(),
  );
  authorized.assignSequence('000000001');
  authorized.prepare({ accessCode, signatureId: 'cert-1', xml: '<factura/>' });
  authorized.sign('<factura firmada/>');
  authorized.markAsSent([]);
  authorized.authorize([]);
  const rejected = Invoice.receive('0f3a9d55-7c2e-5b1a-9e44-3c8d2b6f1a90', makePoint(), makeSale());
  rejected.assignSequence('000000002');
  rejected.prepare({ accessCode, signatureId: 'cert-1', xml: '<factura/>' });
  rejected.sign('<factura firmada/>');
  rejected.reject(['ERROR SECUENCIAL REGISTRADO']);
  return [...authorized.pullEvents(), ...rejected.pullEvents()];
}

describe('invoices v1 contract', () => {
  it('every message the invoice publishes matches the contract', () => {
    const events = publishedEvents();

    for (const event of events) {
      // As it travels: JSON turns occurredAt into an ISO string
      const message = JSON.parse(JSON.stringify(toInvoiceMessage(event)));
      expect(validate(message) ? [] : validate.errors).toEqual([]);
      // The company goes in the faclab-tenant-id header, not in the closed body
      expect(event.tenantId).toBe(TENANT_A);
      expect(message).not.toHaveProperty('tenantId');
    }
    expect(new Set(events.map((event) => event.type))).toEqual(
      new Set([
        'InvoiceReceived',
        'InvoiceCreated',
        'InvoiceSigned',
        'InvoiceSent',
        'InvoiceAuthorized',
        'InvoiceRejected',
      ]),
    );
  });

  it.each(Object.keys(examples))('%s is accepted by the consumer', (name) => {
    expect(validate(examples[name]) ? [] : validate.errors).toEqual([]);
    expect(InvoiceMessageSchema.safeParse(examples[name]).success).toBe(true);
  });

  it('reads a message from before v1 as v1', () => {
    const { schema_version: _, ...legacy } = examples['invoice-authorized'];

    expect(InvoiceMessageSchema.safeParse(legacy).success).toBe(true);
  });
});
