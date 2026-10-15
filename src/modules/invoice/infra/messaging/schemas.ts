import { z } from 'zod';

import { InvoiceStatus } from '../../domain/invoice';
import { IVA_CODE_KEYS } from '../../domain/sri-catalogs';

// --- Kafka Message Schemas ---
// The contracts are the JSON Schemas in contracts/events/, copied from faclab-core (see
// contracts/README.md): test/contract checks these schemas against their examples. A message
// without schema_version predates v1 and is read as v1; another version goes to the DLQ.

export const InvoiceMessageSchema = z.object({
  schema_version: z.literal(1).optional(),
  type: z.string(),
  invoiceId: z.string(),
  saleId: z.string(),
  status: z.nativeEnum(InvoiceStatus),
  occurredAt: z.coerce.date(),
});

export type InvoiceMessage = z.infer<typeof InvoiceMessageSchema>;

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

export const SaleConfirmedMessageSchema = z.object({
  event_id: z.string().uuid(),
  event_type: z.literal('SaleConfirmed'),
  schema_version: z.literal(1).optional(),
  aggregate_id: z.number(),
  occurred_at: z.string().transform((s) => new Date(s.endsWith('Z') ? s : s + 'Z')),
  payload: SaleConfirmedPayloadSchema,
});

export type SaleConfirmedMessage = z.infer<typeof SaleConfirmedMessageSchema>;
