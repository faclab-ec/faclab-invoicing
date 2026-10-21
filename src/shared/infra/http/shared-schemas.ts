export const metaSchema = {
  type: 'object',
  properties: {
    requestId: { type: 'string' },
    timestamp: { type: 'string', format: 'date-time' },
  },
  required: ['requestId', 'timestamp'],
} as const;

export const errorItemSchema = {
  type: 'object',
  properties: {
    code: { type: 'string' },
    message: { type: 'string' },
  },
  required: ['code', 'message'],
} as const;

export const errorResponseSchema = {
  type: 'object',
  properties: {
    errors: { type: 'array', items: errorItemSchema },
    meta: metaSchema,
  },
  required: ['errors', 'meta'],
} as const;

export function successSchema(dataSchema: object): object {
  return {
    type: 'object',
    properties: {
      data: dataSchema,
      meta: metaSchema,
    },
    required: ['data', 'meta'],
  };
}

// Same as faclab-core's paginated lists
export const paginationSchema = {
  type: 'object',
  description: 'Pagination details.',
  properties: {
    total: { type: 'integer', description: 'Records that match the query, in all pages.' },
    limit: { type: 'integer', description: 'Maximum records per page (as requested).' },
    offset: { type: 'integer', description: 'Records skipped (as requested).' },
  },
  required: ['total', 'limit', 'offset'],
} as const;

/** A page of `itemSchema` in `data`, with `meta.pagination` */
export function paginatedSchema(itemSchema: object): object {
  return {
    type: 'object',
    properties: {
      data: { type: 'array', items: itemSchema },
      meta: {
        ...metaSchema,
        properties: { ...metaSchema.properties, pagination: paginationSchema },
        required: [...metaSchema.required, 'pagination'],
      },
    },
    required: ['data', 'meta'],
  };
}
