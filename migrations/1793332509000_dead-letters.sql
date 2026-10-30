-- Up Migration

-- S4.3: a Kafka message the consumer gave up on (malformed, or still failing after its retries)
-- is kept here, with its headers and the error, instead of the `dlq` topic: it stays until someone
-- processes it again (`npm run cli -- dead-letter-reprocess`), who is recorded with the result.
-- If it can't be kept, the consumer doesn't commit its offset and the message comes back.
-- Like faclab-core's `dead_letters`. `tenant_id` is the company of the message, when it carried one.
CREATE TABLE dead_letters (
  id bigserial PRIMARY KEY,
  consumer_group text NOT NULL,
  topic text NOT NULL,
  kafka_partition integer NOT NULL,
  kafka_offset bigint NOT NULL,
  key text,
  tenant_id uuid,
  headers jsonb NOT NULL DEFAULT '{}',
  value text NOT NULL,
  error text NOT NULL,
  error_type text NOT NULL CHECK (error_type IN ('NON_RETRYABLE', 'MAX_RETRIES_EXHAUSTED')),
  attempts integer NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'reprocessed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Who processed it again, and when; the error of the last attempt that failed
  reprocessed_at timestamptz,
  reprocessed_by text,
  reprocess_error text,
  -- A message delivered again after its offset commit failed is kept once
  CONSTRAINT uq_dead_letters_message UNIQUE (consumer_group, topic, kafka_partition, kafka_offset)
);

CREATE INDEX ix_dead_letters_pending ON dead_letters (id) WHERE status = 'pending';

-- Down Migration

DROP TABLE dead_letters;
