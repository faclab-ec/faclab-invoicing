import { metrics } from '@opentelemetry/api';

const meter = metrics.getMeter('faclab-invoicing');

export const kafkaMessageDuration = meter.createHistogram('kafka.consumer.message.duration', {
  description: 'Duration of Kafka message processing',
  unit: 'ms',
});

export const kafkaMessageCount = meter.createCounter('kafka.consumer.message.count', {
  description: 'Number of Kafka messages processed',
});

export const kafkaRetryCount = meter.createCounter('kafka.consumer.retry.count', {
  description: 'Number of Kafka message processing retries',
});

export const dlqMessageCount = meter.createCounter('dlq.message.count', {
  description: 'Number of Kafka messages kept as dead letters',
});

export const soapCallDuration = meter.createHistogram('soap.call.duration', {
  description: 'Duration of SOAP calls',
  unit: 'ms',
});
