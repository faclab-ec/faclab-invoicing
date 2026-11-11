import { z } from 'zod';

import { IVA_CODE_KEYS } from '../../domain/sri-catalogs';

// --- Kafka Message Schemas ---
// The contracts are the JSON Schemas in contracts/events/, copied from faclab-core (see
// contracts/README.md): test/contract checks these schemas against their examples. A message
// without schema_version predates v1 and is read as v1; a version not listed here is kept as a dead
// letter.
// `sales.confirmed` and `credit_notes.requested` come in; `invoices` and `credit_notes.results` go
// out to faclab-core.

const SaleConfirmedCustomerSchema = z.object({
  id: z.number(),
  name: z.string(),
  tax_id: z.string(),
  tax_type: z.enum(['RUC', 'NATIONAL_ID', 'PASSPORT', 'FOREIGN_ID']),
  // Customers may have no contact data; the SRI doesn't require it
  email: z.string().nullable(),
  phone: z.string().nullable(),
  address: z.string().nullable(),
});

// A quantity: a JSON number up to sales.confirmed v2 and credit_notes.requested v1; decimal text with
// at most six decimals since v3 and v2 (S5.1), what `cantidad` takes in the SRI's schema
const QuantityTextSchema = z.string().regex(/^\d+(\.\d{1,6})?$/);

const SaleConfirmedItemSchema = z.object({
  product_id: z.number(),
  // null when the product has no SKU or no longer exists
  sku: z.string().nullable(),
  // Anexo 23 of the technical sheet. Any text: a new code of the SRI must not stop an invoice.
  // Absent in messages from before S4.6
  construction_material_code: z.string().nullable().optional(),
  product_name: z.string().nullable(),
  quantity: z.number(),
  unit_price: z.string(),
  discount: z.string(),
  tax_code: z.enum(IVA_CODE_KEYS),
  tax_amount: z.string(),
  subtotal: z.string(),
  // Invoice amounts: rounded to cents, with the sale discount prorated
  invoice_discount: z.string(),
  invoice_base: z.string(),
  invoice_tax: z.string(),
});

const SaleConfirmedDecimalItemSchema = SaleConfirmedItemSchema.extend({
  quantity: QuantityTextSchema,
});

const SaleConfirmedPaymentSchema = z.object({
  // CREDIT (S5.5): what the customer owes on its account, with its terms in days
  method: z.enum(['CASH', 'CREDIT_CARD', 'DEBIT_CARD', 'TRANSFER', 'OTHER', 'CREDIT']),
  amount: z.string(),
  term_days: z.number().int().min(0).optional(),
});

const SaleConfirmedPayloadSchema = z.object({
  sale_id: z.number(),
  source: z.string(),
  subtotal: z.string(),
  total_discount: z.string(),
  total: z.string(),
  customer: SaleConfirmedCustomerSchema.nullable(),
  items: z.array(SaleConfirmedItemSchema),
  payments: z.array(SaleConfirmedPaymentSchema),
});

const SaleConfirmedEnvelope = {
  event_id: z.string().uuid(),
  event_type: z.literal('SaleConfirmed'),
  aggregate_id: z.number(),
  occurred_at: z.string().transform((s) => new Date(s.endsWith('Z') ? s : s + 'Z')),
};

// Establishment and emission point codes: three digits, 001 to 999
const SriCodeSchema = z.string().regex(/^(00[1-9]|0[1-9]\d|[1-9]\d{2})$/);

// v1: no company nor emission point. Only development invoices it, with a default issuer
export const SaleConfirmedV1MessageSchema = z.object({
  ...SaleConfirmedEnvelope,
  schema_version: z.literal(1).optional(),
  payload: SaleConfirmedPayloadSchema,
});

// v2: the company that issues, its RUC and the sale's establishment and emission point
export const SaleConfirmedV2MessageSchema = z.object({
  ...SaleConfirmedEnvelope,
  schema_version: z.literal(2),
  tenant_id: z.string().uuid(),
  payload: SaleConfirmedPayloadSchema.extend({
    sale_number: z.string().nullable(),
    issuer_ruc: z.string().regex(/^\d{13}$/),
    establishment_code: SriCodeSchema,
    establishment_address: z.string().nullable(),
    emission_point_code: SriCodeSchema,
  }),
});

// v3: v2 with each quantity as decimal text (2.5 m of cable)
export const SaleConfirmedV3MessageSchema = SaleConfirmedV2MessageSchema.extend({
  schema_version: z.literal(3),
  payload: SaleConfirmedV2MessageSchema.shape.payload.extend({
    items: z.array(SaleConfirmedDecimalItemSchema),
  }),
});

export const SaleConfirmedMessageSchema = z.union([
  SaleConfirmedV3MessageSchema,
  SaleConfirmedV2MessageSchema,
  SaleConfirmedV1MessageSchema,
]);

export type SaleConfirmedV1Message = z.infer<typeof SaleConfirmedV1MessageSchema>;
export type SaleConfirmedV2Message = z.infer<typeof SaleConfirmedV2MessageSchema>;
export type SaleConfirmedV3Message = z.infer<typeof SaleConfirmedV3MessageSchema>;
export type SaleConfirmedMessage = z.infer<typeof SaleConfirmedMessageSchema>;

const CreditNoteItemSchema = z.object({
  product_id: z.number(),
  sku: z.string().nullable(),
  construction_material_code: z.string().nullable().optional(),
  product_name: z.string().nullable(),
  quantity: z.number(),
  unit_price: z.string(),
  tax_code: z.enum(IVA_CODE_KEYS),
  invoice_discount: z.string(),
  invoice_base: z.string(),
  invoice_tax: z.string(),
});

// v1: what to credit and from where; the buyer and the invoice's number come from the invoice
export const CreditNoteRequestedV1MessageSchema = z.object({
  event_id: z.string().uuid(),
  event_type: z.literal('CreditNoteRequested'),
  schema_version: z.literal(1),
  tenant_id: z.string().uuid(),
  aggregate_id: z.number(),
  occurred_at: z.string().transform((s) => new Date(s.endsWith('Z') ? s : s + 'Z')),
  payload: z.object({
    credit_note_id: z.number(),
    sale_id: z.number(),
    invoice_id: z.string().uuid(),
    refund_id: z.number().nullable(),
    refund_number: z.string().nullable(),
    issuer_ruc: z.string().regex(/^\d{13}$/),
    establishment_code: SriCodeSchema,
    establishment_address: z.string().nullable(),
    emission_point_code: SriCodeSchema,
    reason: z.string().min(1),
    subtotal: z.string(),
    tax: z.string(),
    total: z.string(),
    items: z.array(CreditNoteItemSchema).min(1),
  }),
});

// v2: v1 with each quantity as decimal text
export const CreditNoteRequestedV2MessageSchema = CreditNoteRequestedV1MessageSchema.extend({
  schema_version: z.literal(2),
  payload: CreditNoteRequestedV1MessageSchema.shape.payload.extend({
    items: z.array(CreditNoteItemSchema.extend({ quantity: QuantityTextSchema })).min(1),
  }),
});

export const CreditNoteRequestedMessageSchema = z.union([
  CreditNoteRequestedV2MessageSchema,
  CreditNoteRequestedV1MessageSchema,
]);

export type CreditNoteRequestedV2Message = z.infer<typeof CreditNoteRequestedV2MessageSchema>;
export type CreditNoteRequestedMessage = z.infer<typeof CreditNoteRequestedMessageSchema>;
