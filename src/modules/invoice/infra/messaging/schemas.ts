import { z } from 'zod';

import { IVA_CODE_KEYS } from '../../domain/sri-catalogs';

// --- Kafka Message Schemas ---
// The contracts are the JSON Schemas in contracts/events/, copied from faclab-core (see
// contracts/README.md): test/contract checks these schemas against their examples. A message
// without schema_version predates v1 and is read as v1; a version not listed here is kept as a dead
// letter.
// Only `sales.confirmed` comes in: `invoices` goes out to faclab-core (S4.2).

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

const SaleConfirmedItemSchema = z.object({
  product_id: z.number(),
  // null when the product has no SKU or no longer exists
  sku: z.string().nullable(),
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

const SaleConfirmedPaymentSchema = z.object({
  method: z.enum(['CASH', 'CREDIT_CARD', 'DEBIT_CARD', 'TRANSFER', 'OTHER']),
  amount: z.string(),
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

export const SaleConfirmedMessageSchema = z.union([
  SaleConfirmedV2MessageSchema,
  SaleConfirmedV1MessageSchema,
]);

export type SaleConfirmedV1Message = z.infer<typeof SaleConfirmedV1MessageSchema>;
export type SaleConfirmedV2Message = z.infer<typeof SaleConfirmedV2MessageSchema>;
export type SaleConfirmedMessage = z.infer<typeof SaleConfirmedMessageSchema>;
