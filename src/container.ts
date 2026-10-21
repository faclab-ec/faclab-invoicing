import { KafkaJS } from '@confluentinc/kafka-javascript';

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
import { InvoiceEventHandler } from '#/modules/invoice/app/handlers/invoice-event.handler';
import { SaleConfirmedHandler } from '#/modules/invoice/app/handlers/sale-confirmed.handler';
import {
  FindInvoicesBySaleIdQuery,
  GetInvoiceQuery,
  GetInvoicingStatusQuery,
  ListInvoicesQuery,
} from '#/modules/invoice/app/queries/invoice.queries';
import { InvoiceRecoveryService } from '#/modules/invoice/app/services/invoice-recovery';
import { InvoiceStatus } from '#/modules/invoice/domain/invoice';
import { SignerAdapter } from '#/modules/invoice/infra/adapters/signer.adapter';
import { SriAuthorizationAdapter } from '#/modules/invoice/infra/adapters/sri-authorization.adapter';
import { SriClients } from '#/modules/invoice/infra/adapters/sri-clients';
import { SriValidationAdapter } from '#/modules/invoice/infra/adapters/sri-validation.adapter';
import { registerInvoiceRoutes } from '#/modules/invoice/infra/http/invoice.routes';
import { invoiceTenant, toInvoiceMessage } from '#/modules/invoice/infra/messaging/invoice-message';
import { InvoiceKafkaConsumer } from '#/modules/invoice/infra/messaging/kafka-consumer';
import { KafkaProducer } from '#/modules/invoice/infra/messaging/kafka-producer';
import {
  InvoiceMessageSchema,
  SaleConfirmedMessageSchema,
} from '#/modules/invoice/infra/messaging/schemas';
import { KAFKA_TOPICS } from '#/modules/invoice/infra/messaging/topics';
import { PgInvoiceRepository } from '#/modules/invoice/infra/persistence/pg-invoice.repository';
import { RecoveryScheduler } from '#/modules/invoice/infra/recovery-scheduler';
import { XadesSigner } from '#/modules/invoice/infra/signing/xades-signer';
import { createPool } from '#/shared/infra/database';
import { DlqProducer } from '#/shared/infra/dlq-producer';
import { createAuthorize } from '#/shared/infra/http/auth';
import { createHttpServer } from '#/shared/infra/http-server';
import { AesGcmSecretCipher } from '#/shared/infra/secret-cipher';
import { logger } from '#/shared/logger';

export async function createContainer(config: AppConfig) {
  // Infra clients
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

  const pool = createPool(config.database.url);

  // Each invoice goes to the SRI environment of its issuer
  const sriClients = new SriClients(
    config.externalServices.sriEndpoints,
    config.externalServices.sriTimeoutMs,
    config.externalServices.sriProductionAllowed,
  );

  // Repositories
  const invoiceRepository = new PgInvoiceRepository(pool);
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

  // Producers
  const invoiceProducer = new KafkaProducer(
    producer,
    KAFKA_TOPICS.INVOICES,
    toInvoiceMessage,
    invoiceTenant,
  );

  // Commands
  const prepareInvoiceCommand = new PrepareInvoiceCommand(issuerReadiness, invoiceRepository);
  const signInvoiceCommand = new SignInvoiceCommand(signerAdapter, invoiceRepository);
  const sendInvoiceCommand = new SendInvoiceCommand(sriValidationAdapter, invoiceRepository);
  const authorizeInvoiceCommand = new AuthorizeInvoiceCommand(
    sriAuthorizationAdapter,
    invoiceRepository,
  );

  // Command dispatch map
  const commandMap = new Map<InvoiceStatus, InvoiceCommand>([
    [InvoiceStatus.PENDING, prepareInvoiceCommand],
    [InvoiceStatus.CREATED, signInvoiceCommand],
    [InvoiceStatus.SIGNED, sendInvoiceCommand],
    [InvoiceStatus.SENT, authorizeInvoiceCommand],
  ]);

  const receiveSaleCommand = new ReceiveSaleCommand(invoiceRepository);

  // Handlers
  const invoiceEventHandler = new InvoiceEventHandler(
    invoiceRepository,
    commandMap,
    invoiceProducer,
  );
  const saleConfirmedHandler = new SaleConfirmedHandler(
    receiveSaleCommand,
    invoiceProducer,
    config.kafka.salesV1TenantId,
  );

  // Recovery: invoices waiting for the issuer, failed or stuck
  const invoiceRecovery = new InvoiceRecoveryService(
    invoiceRepository,
    issuerReadiness,
    invoiceEventHandler,
  );
  const recoveryScheduler = new RecoveryScheduler(
    invoiceRecovery,
    config.invoiceRecovery.intervalMs,
  );
  // A company's config or certificate change may unblock its pending invoices: check right away
  const issuerListener: IssuerChangeListener = {
    issuerChanged: (tenantId) => {
      issuerReadiness.invalidate(tenantId);
      invoiceRecovery
        .run({ tenantId })
        .catch((error) => logger.error({ err: error }, 'Resuming pending invoices failed'));
    },
  };

  // DLQ
  const dlqProducer = new DlqProducer(producer, KAFKA_TOPICS.DLQ, config.kafka.groupId);

  // Consumer
  const kafkaConsumer = new InvoiceKafkaConsumer(
    consumer,
    [KAFKA_TOPICS.INVOICES, KAFKA_TOPICS.SALES_CONFIRMED],
    {
      [KAFKA_TOPICS.INVOICES]: {
        handler: invoiceEventHandler,
        validator: InvoiceMessageSchema,
      },
      [KAFKA_TOPICS.SALES_CONFIRMED]: {
        handler: saleConfirmedHandler,
        validator: SaleConfirmedMessageSchema,
      },
    },
    dlqProducer,
  );

  // Certificate module
  const uploadCertificateCommand = new UploadCertificateCommand(
    p12Parser,
    certificateRepository,
    companyConfigRepository,
    secretCipher,
    issuerListener,
  );
  const getCertificateCommand = new GetCertificateCommand(certificateRepository);
  const listCertificatesCommand = new ListCertificatesCommand(certificateRepository);
  const deleteCertificateCommand = new DeleteCertificateCommand(
    certificateRepository,
    companyConfigRepository,
    issuerListener,
  );

  // HTTP Server
  const httpServer = await createHttpServer({
    port: config.http.port,
    host: config.http.host,
    corsOrigins: config.http.corsOrigins,
    serviceName: config.serviceName,
    serviceVersion: config.serviceVersion,
  });

  const authorize = createAuthorize(config.auth);

  registerCertificateRoutes(
    httpServer,
    {
      upload: uploadCertificateCommand,
      get: getCertificateCommand,
      list: listCertificatesCommand,
      delete: deleteCertificateCommand,
    },
    authorize,
  );

  // Company config module
  const saveCompanyConfigCommand = new SaveCompanyConfigCommand(
    companyConfigRepository,
    certificateRepository,
    issuerListener,
  );
  const getCompanyConfigQuery = new GetCompanyConfigQuery(companyConfigRepository);

  registerCompanyConfigRoutes(
    httpServer,
    {
      save: saveCompanyConfigCommand,
      get: getCompanyConfigQuery,
      listSequences: new ListSequencesQuery(sequenceRepository),
      setNextSequence: new SetNextSequenceCommand(sequenceRepository),
    },
    authorize,
  );

  registerInvoiceRoutes(
    httpServer,
    {
      get: new GetInvoiceQuery(invoiceRepository),
      list: new ListInvoicesQuery(invoiceRepository, config.timezone),
      findBySaleId: new FindInvoicesBySaleIdQuery(invoiceRepository),
      status: new GetInvoicingStatusQuery(issuerReadiness, invoiceRepository),
      retry: new RetryInvoiceCommand(invoiceRepository, issuerReadiness, invoiceEventHandler),
      retryAll: new RetryInvoicesCommand(invoiceRepository, issuerReadiness, invoiceRecovery),
    },
    authorize,
  );

  await invoiceProducer.connect();

  return {
    consumer: kafkaConsumer,
    producer: invoiceProducer,
    httpServer,
    recoveryScheduler,
    pool,
  };
}
