import { KafkaJS } from '@confluentinc/kafka-javascript';
import { FastifyInstance } from 'fastify';
import { hostname } from 'os';
import { Pool } from 'pg';

import { AppConfig } from '#/config';
import {
  DeleteCertificateCommand,
  GetCertificateCommand,
  ListCertificatesCommand,
  UploadCertificateCommand,
} from '#/modules/certificate/app/certificate.commands';
import { CertificateExpiryReport } from '#/modules/certificate/app/certificate-expiry';
import { CertificateKeyLoader } from '#/modules/certificate/app/certificate-key-loader';
import { P12ParserAdapter } from '#/modules/certificate/infra/adapters/p12-parser.adapter';
import { registerCertificateRoutes } from '#/modules/certificate/infra/http/certificate.routes';
import { PgCertificateRepository } from '#/modules/certificate/infra/persistence/pg-certificate.repository';
import { sampleCertificates } from '#/modules/certificate/infra/telemetry';
import {
  GetCompanyConfigQuery,
  SaveCompanyConfigCommand,
} from '#/modules/company-config/app/company-config.commands';
import {
  DeleteIssuerLogoCommand,
  GetIssuerLogoQuery,
  SetIssuerLogoCommand,
} from '#/modules/company-config/app/issuer-logo.commands';
import { IssuerReadinessService } from '#/modules/company-config/app/issuer-readiness';
import {
  ListSequencesQuery,
  SetNextSequenceCommand,
} from '#/modules/company-config/app/sequence.commands';
import { IssuerChangeListener } from '#/modules/company-config/domain/readiness';
import { registerCompanyConfigRoutes } from '#/modules/company-config/infra/http/company-config.routes';
import { PgCompanyConfigRepository } from '#/modules/company-config/infra/persistence/pg-company-config.repository';
import { PgSequenceRepository } from '#/modules/company-config/infra/persistence/pg-sequence.repository';
import { AuthorizeInvoiceCommand } from '#/modules/invoice/app/commands/authorize-invoice';
import { InvoiceCommand } from '#/modules/invoice/app/commands/command';
import { PrepareInvoiceCommand } from '#/modules/invoice/app/commands/prepare-invoice';
import { ReceiveCreditNoteCommand } from '#/modules/invoice/app/commands/receive-credit-note';
import { ReceiveSaleCommand } from '#/modules/invoice/app/commands/receive-sale';
import { ResendInvoiceEmailCommand } from '#/modules/invoice/app/commands/resend-invoice-email';
import {
  RetryInvoiceCommand,
  RetryInvoicesCommand,
} from '#/modules/invoice/app/commands/retry-invoice';
import { SendInvoiceCommand } from '#/modules/invoice/app/commands/send-invoice';
import { SignInvoiceCommand } from '#/modules/invoice/app/commands/sign-invoice';
import { CreditNoteRequestedHandler } from '#/modules/invoice/app/handlers/credit-note-requested.handler';
import { SaleConfirmedHandler } from '#/modules/invoice/app/handlers/sale-confirmed.handler';
import {
  FindInvoicesBySaleIdQuery,
  GetAuthorizedXmlQuery,
  GetInvoiceQuery,
  GetInvoicingStatusQuery,
  GetRideQuery,
  ListInvoiceDeliveriesQuery,
  ListInvoicesQuery,
} from '#/modules/invoice/app/queries/invoice.queries';
import {
  GetPublicInvoiceQuery,
  ListPublicInvoicesQuery,
} from '#/modules/invoice/app/queries/public-invoice.queries';
import { InvoiceDeliveryProcessor } from '#/modules/invoice/app/services/invoice-delivery-processor';
import { InvoiceProcessor } from '#/modules/invoice/app/services/invoice-processor';
import { InvoiceRecoveryService } from '#/modules/invoice/app/services/invoice-recovery';
import { RideService } from '#/modules/invoice/app/services/ride-service';
import { CreditNoteResultEvent, InvoiceResultEvent } from '#/modules/invoice/domain/events';
import { InvoiceStatus } from '#/modules/invoice/domain/invoice';
import { NodemailerInvoiceMailer } from '#/modules/invoice/infra/adapters/nodemailer-mailer.adapter';
import { PdfKitRideRenderer } from '#/modules/invoice/infra/adapters/pdfkit-ride-renderer';
import { S3DocumentStorage } from '#/modules/invoice/infra/adapters/s3-document-storage.adapter';
import { SignerAdapter } from '#/modules/invoice/infra/adapters/signer.adapter';
import { SriAuthorizationAdapter } from '#/modules/invoice/infra/adapters/sri-authorization.adapter';
import { SriClients } from '#/modules/invoice/infra/adapters/sri-clients';
import { SriValidationAdapter } from '#/modules/invoice/infra/adapters/sri-validation.adapter';
import { XsdInvoiceSchemaValidator } from '#/modules/invoice/infra/adapters/xsd-validator.adapter';
import { registerInvoiceRoutes } from '#/modules/invoice/infra/http/invoice.routes';
import { registerPublicInvoiceRoutes } from '#/modules/invoice/infra/http/v1/public-invoice.routes';
import {
  creditNoteTenant,
  toCreditNoteResultMessage,
} from '#/modules/invoice/infra/messaging/credit-note-message';
import { invoiceTenant, toInvoiceMessage } from '#/modules/invoice/infra/messaging/invoice-message';
import {
  dispatchMessage,
  InvoiceKafkaConsumer,
  MessageProcessors,
} from '#/modules/invoice/infra/messaging/kafka-consumer';
import { KafkaProducer } from '#/modules/invoice/infra/messaging/kafka-producer';
import {
  CreditNoteRequestedMessageSchema,
  SaleConfirmedMessageSchema,
} from '#/modules/invoice/infra/messaging/schemas';
import { KAFKA_TOPICS } from '#/modules/invoice/infra/messaging/topics';
import { VoucherResultProducer } from '#/modules/invoice/infra/messaging/voucher-result-producer';
import { PgInvoiceRepository } from '#/modules/invoice/infra/persistence/pg-invoice.repository';
import { PgInvoiceDeliveryRepository } from '#/modules/invoice/infra/persistence/pg-invoice-delivery.repository';
import { PgInvoiceQueue } from '#/modules/invoice/infra/persistence/pg-invoice-queue';
import { InvoiceWorker } from '#/modules/invoice/infra/queue/invoice-worker';
import { RecoveryScheduler } from '#/modules/invoice/infra/recovery-scheduler';
import { XadesSigner } from '#/modules/invoice/infra/signing/xades-signer';
import { recordDelivery } from '#/modules/invoice/infra/telemetry/delivery-metrics';
import {
  sampleInvoiceQueue,
  samplePendingDeliveries,
} from '#/modules/invoice/infra/telemetry/queue-metrics';
import { measureSteps } from '#/modules/invoice/infra/telemetry/step-metrics';
import { createPool } from '#/shared/infra/database';
import {
  DeadLetterReprocessor,
  DeadLetterStore,
  PgDeadLetterStore,
  sampleDeadLetters,
} from '#/shared/infra/dead-letters';
import { createAuthorize, createRequireScope } from '#/shared/infra/http/auth';
import { JwksKeyStore } from '#/shared/infra/http/jwks';
import { publicApiEnabled } from '#/shared/infra/http/public-api';
import { createRateLimit, PgRateLimiter, purgeRateLimits } from '#/shared/infra/http/rate-limit';
import { createHttpServer } from '#/shared/infra/http-server';
import { consumerOptions } from '#/shared/infra/kafka';
import { PeriodicTask, runSamplers } from '#/shared/infra/periodic-task';
import { QueueWorker } from '#/shared/infra/queue-worker';
import { AesGcmSecretCipher } from '#/shared/infra/secret-cipher';
import { allHealthy, HealthCheck, WorkerHealth } from '#/shared/infra/worker-health';
import { logger } from '#/shared/logger';
import { captureTraceContext } from '#/shared/telemetry/trace-context';

/**
 * What runs in the background: the consumer of sales.confirmed, the workers (invoices and their
 * deliveries) and the recovery
 */
export interface Background {
  // The worker's cycles: the worker process answers /health with it
  health: HealthCheck;
  start(): Promise<void>;
  /** In order: no new sales, the invoices and deliveries in progress finish, then Kafka */
  stop(): Promise<void>;
}

export interface Container {
  pool: Pool;
  createHttpServer(): Promise<FastifyInstance>;
  /** Connects to Kafka only when started: the API without RUN_BACKGROUND never does */
  createBackground(): Background;
  deadLetters: DeadLetterStore;
  /** Processes dead letters again with the consumer's handlers, without Kafka (the CLI) */
  createDeadLetterReprocessor(): DeadLetterReprocessor;
}

// The rate limit counters of the public API are purged this often (S6.3)
const RATE_LIMIT_PURGE_INTERVAL_MS = 60 * 60 * 1000;
// The certificates about to expire are logged daily (S7.2), and when the worker starts
const CERTIFICATE_REPORT_INTERVAL_MS = 24 * 60 * 60 * 1000;

export function createContainer(config: AppConfig): Container {
  const pool = createPool(config.database.url);
  // This process in the queue's locks; each holder adds what it is (a worker slot, the API)
  const processHolder = `${hostname()}:${process.pid}`;
  const { concurrency, pollIntervalMs, lockTimeoutMs } = config.invoiceQueue;

  // Each invoice goes to the SRI environment of its issuer
  const sriClients = new SriClients(
    config.externalServices.sriEndpoints,
    config.externalServices.sriTimeoutMs,
    config.externalServices.sriProductionAllowed,
  );

  // Repositories
  const invoiceRepository = new PgInvoiceRepository(pool);
  const invoiceQueue = new PgInvoiceQueue(pool);
  const deliveryRepository = new PgInvoiceDeliveryRepository(pool);
  const certificateRepository = new PgCertificateRepository(pool);
  const companyConfigRepository = new PgCompanyConfigRepository(pool);
  const sequenceRepository = new PgSequenceRepository(pool);

  // Issuer: certificates and readiness
  const p12Parser = new P12ParserAdapter();
  const secretCipher = new AesGcmSecretCipher(config.signing.passwordKey);
  const certificateKeyLoader = new CertificateKeyLoader(secretCipher);
  const issuerReadiness = new IssuerReadinessService(
    companyConfigRepository,
    certificateRepository,
    certificateKeyLoader,
    p12Parser,
    { productionAllowed: config.externalServices.sriProductionAllowed },
  );

  // Adapters
  const xadesSigner = new XadesSigner(config.timezone);
  const signerAdapter = new SignerAdapter(issuerReadiness, certificateKeyLoader, xadesSigner);
  const sriValidationAdapter = new SriValidationAdapter(sriClients);
  const sriAuthorizationAdapter = new SriAuthorizationAdapter(sriClients);
  const schemaValidator = new XsdInvoiceSchemaValidator();
  const documentStorage = new S3DocumentStorage(config.objectStorage);
  // The RIDE: the API (download) and the worker (delivery) generate it the same way
  const rideService = new RideService(
    documentStorage,
    companyConfigRepository,
    new PdfKitRideRenderer(),
    config.timezone,
  );

  // Commands
  const prepareInvoiceCommand = new PrepareInvoiceCommand(
    issuerReadiness,
    invoiceRepository,
    schemaValidator,
    config.invoicing,
  );
  const signInvoiceCommand = new SignInvoiceCommand(signerAdapter, invoiceRepository);
  const sendInvoiceCommand = new SendInvoiceCommand(sriValidationAdapter, invoiceRepository);
  const authorizeInvoiceCommand = new AuthorizeInvoiceCommand(
    sriAuthorizationAdapter,
    invoiceRepository,
    documentStorage,
    captureTraceContext,
  );

  // Command dispatch map, each step measured: duration, transitions and time to the result (S7.2)
  const commandMap = measureSteps(
    new Map<InvoiceStatus, InvoiceCommand>([
      [InvoiceStatus.PENDING, prepareInvoiceCommand],
      [InvoiceStatus.CREATED, signInvoiceCommand],
      [InvoiceStatus.SIGNED, sendInvoiceCommand],
      [InvoiceStatus.SENT, authorizeInvoiceCommand],
    ]),
  );

  // Steps run from the API (manual retry): the worker publishes their result
  const apiProcessor = new InvoiceProcessor(
    invoiceRepository,
    invoiceQueue,
    commandMap,
    issuerReadiness,
    null,
  );

  // Messages the consumer gave up on, until someone processes them again
  const deadLetters = new PgDeadLetterStore(pool, config.kafka.groupId);
  // What each topic does with a message; the reprocessing of dead letters runs it too
  function messageProcessors(withTrace: boolean): MessageProcessors {
    // Only stores the sale: the worker invoices it
    const saleConfirmedHandler = new SaleConfirmedHandler(
      new ReceiveSaleCommand(invoiceRepository, withTrace ? captureTraceContext : undefined),
      config.kafka.salesV1TenantId,
    );
    const creditNoteRequestedHandler = new CreditNoteRequestedHandler(
      new ReceiveCreditNoteCommand(invoiceRepository, withTrace ? captureTraceContext : undefined),
    );
    return {
      [KAFKA_TOPICS.SALES_CONFIRMED]: {
        handler: saleConfirmedHandler,
        validator: SaleConfirmedMessageSchema,
      },
      [KAFKA_TOPICS.CREDIT_NOTES_REQUESTED]: {
        handler: creditNoteRequestedHandler,
        validator: CreditNoteRequestedMessageSchema,
      },
    };
  }

  // Recovery: invoices waiting for the issuer, back in the queue once it is ready
  const invoiceRecovery = new InvoiceRecoveryService(invoiceQueue, issuerReadiness);
  // A company's config or certificate change may unblock its pending invoices: check right away
  const issuerListener: IssuerChangeListener = {
    issuerChanged: (tenantId) => {
      issuerReadiness.invalidate(tenantId);
      invoiceRecovery
        .run({ tenantId })
        .catch((error) => logger.error({ err: error }, 'Resuming pending invoices failed'));
    },
  };

  async function buildHttpServer(): Promise<FastifyInstance> {
    const httpServer = await createHttpServer({
      port: config.http.port,
      host: config.http.host,
      corsOrigins: config.http.corsOrigins,
      serviceName: config.serviceName,
      serviceVersion: config.serviceVersion,
    });

    const authConfig = {
      issuer: config.auth.issuer,
      audience: config.auth.audience,
      keys: new JwksKeyStore({ url: config.auth.jwksUrl }),
    };
    const authorize = createAuthorize(authConfig);

    // Certificate module
    registerCertificateRoutes(
      httpServer,
      {
        upload: new UploadCertificateCommand(
          p12Parser,
          certificateRepository,
          companyConfigRepository,
          secretCipher,
          issuerListener,
        ),
        get: new GetCertificateCommand(certificateRepository),
        list: new ListCertificatesCommand(certificateRepository),
        delete: new DeleteCertificateCommand(
          certificateRepository,
          companyConfigRepository,
          issuerListener,
        ),
      },
      authorize,
    );

    // Company config module
    registerCompanyConfigRoutes(
      httpServer,
      {
        save: new SaveCompanyConfigCommand(
          companyConfigRepository,
          certificateRepository,
          issuerListener,
        ),
        get: new GetCompanyConfigQuery(companyConfigRepository),
        listSequences: new ListSequencesQuery(sequenceRepository),
        setNextSequence: new SetNextSequenceCommand(sequenceRepository),
        setLogo: new SetIssuerLogoCommand(companyConfigRepository, documentStorage),
        deleteLogo: new DeleteIssuerLogoCommand(companyConfigRepository, documentStorage),
        getLogo: new GetIssuerLogoQuery(companyConfigRepository, documentStorage),
      },
      authorize,
    );

    registerInvoiceRoutes(
      httpServer,
      {
        get: new GetInvoiceQuery(invoiceRepository),
        authorizedXml: new GetAuthorizedXmlQuery(invoiceRepository, documentStorage),
        ride: new GetRideQuery(invoiceRepository, rideService),
        list: new ListInvoicesQuery(invoiceRepository, config.timezone),
        findBySaleId: new FindInvoicesBySaleIdQuery(invoiceRepository),
        status: new GetInvoicingStatusQuery(issuerReadiness, invoiceRepository),
        retry: new RetryInvoiceCommand(
          invoiceRepository,
          invoiceQueue,
          issuerReadiness,
          apiProcessor,
          { holder: `${processHolder}:api`, leaseMs: lockTimeoutMs },
        ),
        retryAll: new RetryInvoicesCommand(issuerReadiness, invoiceRecovery),
        resendEmail: new ResendInvoiceEmailCommand(
          invoiceRepository,
          deliveryRepository,
          config.invoiceEmail.enabled,
          captureTraceContext,
        ),
        deliveries: new ListInvoiceDeliveriesQuery(invoiceRepository, deliveryRepository),
      },
      authorize,
    );

    // The public API for integration clients (S6.3), with faclab-core's tokens and scopes
    const { rateLimit } = config.publicApi;
    registerPublicInvoiceRoutes(
      httpServer,
      {
        list: new ListPublicInvoicesQuery(invoiceRepository),
        get: new GetPublicInvoiceQuery(invoiceRepository),
        authorizedXml: new GetAuthorizedXmlQuery(invoiceRepository, documentStorage),
        ride: new GetRideQuery(invoiceRepository, rideService),
      },
      {
        enabled: publicApiEnabled(config.publicApi.enabled),
        requireScope: createRequireScope(authConfig),
        rateLimit: createRateLimit(rateLimit.enabled ? new PgRateLimiter(pool) : null, {
          client: rateLimit.client,
          tenant: rateLimit.tenant,
        }),
      },
    );

    return httpServer;
  }

  function buildBackground(): Background {
    const kafka = new KafkaJS.Kafka({
      kafkaJS: {
        brokers: config.kafka.brokers,
        clientId: 'faclab-invoicing',
        logLevel: KafkaJS.logLevel.INFO,
      },
    });
    const consumer = kafka.consumer({ kafkaJS: consumerOptions(config.kafka.groupId) });
    const producer = kafka.producer({
      kafkaJS: {
        acks: -1,
      },
      'enable.idempotence': true,
      'max.in.flight.requests.per.connection': 5,
    });

    // Results for faclab-core: the only messages on `invoices` and `credit_notes.results`. Both go
    // through the same connection: starting and stopping the first one is enough
    const invoiceResults = new KafkaProducer<InvoiceResultEvent>(
      producer,
      KAFKA_TOPICS.INVOICES,
      toInvoiceMessage,
      invoiceTenant,
    );
    const resultProducer = new VoucherResultProducer(
      invoiceResults,
      new KafkaProducer<CreditNoteResultEvent>(
        producer,
        KAFKA_TOPICS.CREDIT_NOTES_RESULTS,
        toCreditNoteResultMessage,
        creditNoteTenant,
      ),
    );
    const consumedTopics = [KAFKA_TOPICS.SALES_CONFIRMED, KAFKA_TOPICS.CREDIT_NOTES_REQUESTED];
    const kafkaConsumer = new InvoiceKafkaConsumer(
      consumer,
      consumedTopics,
      messageProcessors(true),
      deadLetters,
      { groupId: config.kafka.groupId },
    );

    const processor = new InvoiceProcessor(
      invoiceRepository,
      invoiceQueue,
      commandMap,
      issuerReadiness,
      resultProducer,
      config.invoiceRecovery.intervalMs,
    );
    // A slot busy with one invoice beats again within its lease
    const invoiceHealth = new WorkerHealth(lockTimeoutMs + 2 * pollIntervalMs);
    const worker = new InvoiceWorker(
      invoiceQueue,
      processor,
      {
        concurrency,
        pollIntervalMs,
        leaseMs: lockTimeoutMs,
        errorBackoffMs: config.invoiceRecovery.intervalMs,
        holder: processHolder,
      },
      invoiceHealth,
    );

    // The delivery of each authorized invoice: its RIDE and the email to the buyer
    const mailer = config.invoiceEmail.enabled
      ? new NodemailerInvoiceMailer(config.invoiceEmail.smtp)
      : null;
    const deliveryProcessor = new InvoiceDeliveryProcessor(
      deliveryRepository,
      invoiceRepository,
      rideService,
      documentStorage,
      companyConfigRepository,
      mailer,
      config.invoiceEmail.from,
    );
    const deliveryHealth = new WorkerHealth(lockTimeoutMs + 2 * pollIntervalMs);
    const deliveryWorker = new QueueWorker(
      deliveryRepository,
      async (job) => recordDelivery(await deliveryProcessor.run(job.id)),
      {
        name: 'Delivery worker',
        spanName: 'deliver invoice',
        attributes: (job) => ({ 'faclab.delivery.id': job.id, 'faclab.invoice.id': job.invoiceId }),
        logFields: (job) => ({ deliveryId: job.id, invoiceId: job.invoiceId }),
      },
      {
        concurrency: config.invoiceEmail.concurrency,
        pollIntervalMs,
        leaseMs: lockTimeoutMs,
        errorBackoffMs: config.invoiceRecovery.intervalMs,
        holder: `${processHolder}:delivery`,
      },
      deliveryHealth,
    );
    const recoveryScheduler = new RecoveryScheduler(
      invoiceRecovery,
      config.invoiceRecovery.intervalMs,
    );
    let rateLimitPurge: ReturnType<typeof setInterval> | undefined;

    // The gauges of the metrics (S7.2), sampled across companies; a sample lasts three intervals
    const { metricsIntervalMs } = config.telemetry;
    const sampleAgeMs = 3 * metricsIntervalMs;
    const certificateReport = new CertificateExpiryReport(certificateRepository);
    const metricsSampling = new PeriodicTask({
      name: 'Metrics sampling',
      intervalMs: metricsIntervalMs,
      run: () =>
        runSamplers({
          queue: () => sampleInvoiceQueue(invoiceQueue, new Date(), sampleAgeMs),
          deliveries: () => samplePendingDeliveries(deliveryRepository, sampleAgeMs),
          deadLetters: () => sampleDeadLetters(deadLetters, consumedTopics, sampleAgeMs),
          certificates: () => sampleCertificates(certificateReport, sampleAgeMs),
        }),
    });
    // One log per company whose signing certificate expired or expires within 30 days (G-23)
    const certificateExpiry = new PeriodicTask({
      name: 'Certificate expiry report',
      intervalMs: CERTIFICATE_REPORT_INTERVAL_MS,
      run: () => certificateReport.report(),
    });

    return {
      health: allHealthy(invoiceHealth, deliveryHealth),
      async start() {
        await invoiceResults.connect();
        await kafkaConsumer.start();
        worker.start();
        deliveryWorker.start();
        recoveryScheduler.start();
        metricsSampling.start();
        certificateExpiry.start();
        // The public API's rate limit counters whose bucket is full again (S6.3), hourly
        rateLimitPurge = setInterval(() => {
          purgeRateLimits(pool)
            .then((deleted) => logger.info({ deleted }, 'Rate limit counters purged'))
            .catch((error) => logger.error({ err: error }, 'Purging rate limit counters failed'));
        }, RATE_LIMIT_PURGE_INTERVAL_MS);
        rateLimitPurge.unref();
      },
      async stop() {
        await kafkaConsumer.stop();
        await worker.stop();
        await deliveryWorker.stop();
        mailer?.close();
        recoveryScheduler.stop();
        await metricsSampling.stop();
        await certificateExpiry.stop();
        if (rateLimitPurge) clearInterval(rateLimitPurge);
        await invoiceResults.disconnect();
      },
    };
  }

  function buildDeadLetterReprocessor(): DeadLetterReprocessor {
    const processors = messageProcessors(false);
    return new DeadLetterReprocessor(deadLetters, (topic, value) =>
      dispatchMessage(processors, topic, value),
    );
  }

  return {
    pool,
    createHttpServer: buildHttpServer,
    createBackground: buildBackground,
    deadLetters,
    createDeadLetterReprocessor: buildDeadLetterReprocessor,
  };
}
