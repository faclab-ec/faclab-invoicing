import { z } from 'zod';

import { InvoiceStatus } from '../../domain/invoice';
import { IVA_CODE_KEYS } from '../../domain/sri-catalogs';

// --- Kafka Message Schemas ---

export const InvoiceMessageSchema = z.object({
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
  email: z.string(),
  phone: z.string(),
  address: z.string(),
});

const SaleConfirmedItemSchema = z.object({
  product_id: z.number(),
  sku: z.string(),
  product_name: z.string(),
  quantity: z.number(),
  unit_price: z.string(),
  discount: z.string(),
  tax_code: z.enum(IVA_CODE_KEYS),
  tax_amount: z.string(),
  subtotal: z.string(),
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
  aggregate_id: z.number(),
  occurred_at: z.string().transform((s) => new Date(s.endsWith('Z') ? s : s + 'Z')),
  payload: SaleConfirmedPayloadSchema,
});

export type SaleConfirmedMessage = z.infer<typeof SaleConfirmedMessageSchema>;
