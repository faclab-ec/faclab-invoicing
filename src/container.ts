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
import { CertificateKeyLoader } from '#/modules/certificate/app/certificate-key-loader';
import { P12ParserAdapter } from '#/modules/certificate/infra/adapters/p12-parser.adapter';
import { registerCertificateRoutes } from '#/modules/certificate/infra/http/certificate.routes';
import { PgCertificateRepository } from '#/modules/certificate/infra/persistence/pg-certificate.repository';
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
import { ReceiveSaleCommand } from '#/modules/invoice/app/commands/receive-sale';
import {
  RetryInvoiceCommand,
  RetryInvoicesCommand,
} from '#/modules/invoice/app/commands/retry-invoice';
import { SendInvoiceCommand } from '#/modules/invoice/app/commands/send-invoice';
import { SignInvoiceCommand } from '#/modules/invoice/app/commands/sign-invoice';
import { SaleConfirmedHandler } from '#/modules/invoice/app/handlers/sale-confirmed.handler';
import {
  FindInvoicesBySaleIdQuery,
  GetAuthorizedXmlQuery,
  GetInvoiceQuery,
  GetInvoicingStatusQuery,
  GetRideQuery,
  ListInvoicesQuery,
} from '#/modules/invoice/app/queries/invoice.queries';
import { InvoiceProcessor } from '#/modules/invoice/app/services/invoice-processor';
import { InvoiceRecoveryService } from '#/modules/invoice/app/services/invoice-recovery';
import { RideService } from '#/modules/invoice/app/services/ride-service';
import { InvoiceResultEvent } from '#/modules/invoice/domain/events';
import { InvoiceStatus } from '#/modules/invoice/domain/invoice';
import { PdfKitRideRenderer } from '#/modules/invoice/infra/adapters/pdfkit-ride-renderer';
import { S3DocumentStorage } from '#/modules/invoice/infra/adapters/s3-document-storage.adapter';
import { SignerAdapter } from '#/modules/invoice/infra/adapters/signer.adapter';
import { SriAuthorizationAdapter } from '#/modules/invoice/infra/adapters/sri-authorization.adapter';
import { SriClients } from '#/modules/invoice/infra/adapters/sri-clients';
import { SriValidationAdapter } from '#/modules/invoice/infra/adapters/sri-validation.adapter';
import { XsdInvoiceSchemaValidator } from '#/modules/invoice/infra/adapters/xsd-validator.adapter';
import { registerInvoiceRoutes } from '#/modules/invoice/infra/http/invoice.routes';
import { invoiceTenant, toInvoiceMessage } from '#/modules/invoice/infra/messaging/invoice-message';
import {
  dispatchMessage,
  InvoiceKafkaConsumer,
  MessageProcessors,
} from '#/modules/invoice/infra/messaging/kafka-consumer';
import { KafkaProducer } from '#/modules/invoice/infra/messaging/kafka-producer';
import { SaleConfirmedMessageSchema } from '#/modules/invoice/infra/messaging/schemas';
import { KAFKA_TOPICS } from '#/modules/invoice/infra/messaging/topics';
import { PgInvoiceRepository } from '#/modules/invoice/infra/persistence/pg-invoice.repository';
import { PgInvoiceQueue } from '#/modules/invoice/infra/persistence/pg-invoice-queue';
import { InvoiceWorker } from '#/modules/invoice/infra/queue/invoice-worker';
import { RecoveryScheduler } from '#/modules/invoice/infra/recovery-scheduler';
import { XadesSigner } from '#/modules/invoice/infra/signing/xades-signer';
import { createPool } from '#/shared/infra/database';
import {
  DeadLetterReprocessor,
  DeadLetterStore,
  PgDeadLetterStore,
} from '#/shared/infra/dead-letters';
import { createAuthorize } from '#/shared/infra/http/auth';
import { createHttpServer } from '#/shared/infra/http-server';
import { AesGcmSecretCipher } from '#/shared/infra/secret-cipher';
import { WorkerHealth } from '#/shared/infra/worker-health';
import { logger } from '#/shared/logger';
import { captureTraceContext } from '#/shared/telemetry/trace-context';

/** What runs in the background: the consumer of sales.confirmed, the worker and the recovery */
export interface Background {
  // The worker's cycles: the worker process answers /health with it
  health: WorkerHealth;
  start(): Promise<void>;
  /** In order: no new sales, the invoices in progress finish, then Kafka */
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
  );

  // Command dispatch map
  const commandMap = new Map<InvoiceStatus, InvoiceCommand>([
    [InvoiceStatus.PENDING, prepareInvoiceCommand],
    [InvoiceStatus.CREATED, signInvoiceCommand],
    [InvoiceStatus.SIGNED, sendInvoiceCommand],
    [InvoiceStatus.SENT, authorizeInvoiceCommand],
  ]);

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
    return {
      [KAFKA_TOPICS.SALES_CONFIRMED]: {
        handler: saleConfirmedHandler,
        validator: SaleConfirmedMessageSchema,
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

    const authorize = createAuthorize(config.auth);

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
      },
      authorize,
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
    const consumer = kafka.consumer({
      kafkaJS: {
        groupId: config.kafka.groupId,
        autoCommit: false,
      },
    });
    const producer = kafka.producer({
      kafkaJS: {
        acks: -1,
      },
      'enable.idempotence': true,
      'max.in.flight.requests.per.connection': 5,
    });

    // Results for faclab-core: the only messages on `invoices`
    const resultProducer = new KafkaProducer<InvoiceResultEvent>(
      producer,
      KAFKA_TOPICS.INVOICES,
      toInvoiceMessage,
      invoiceTenant,
    );
    const kafkaConsumer = new InvoiceKafkaConsumer(
      consumer,
      [KAFKA_TOPICS.SALES_CONFIRMED],
      messageProcessors(true),
      deadLetters,
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
    const health = new WorkerHealth(lockTimeoutMs + 2 * pollIntervalMs);
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
      health,
    );
    const recoveryScheduler = new RecoveryScheduler(
      invoiceRecovery,
      config.invoiceRecovery.intervalMs,
    );

    return {
      health,
      async start() {
        await resultProducer.connect();
        await kafkaConsumer.start();
        worker.start();
        recoveryScheduler.start();
      },
      async stop() {
        await kafkaConsumer.stop();
        await worker.stop();
        recoveryScheduler.stop();
        await resultProducer.disconnect();
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
