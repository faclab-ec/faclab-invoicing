import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { S3Client } from '@aws-sdk/client-s3';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { KafkaJS } from '@confluentinc/kafka-javascript';

import { AppConfig } from '#/config';
import {
  DeleteCertificateCommand,
  GetCertificateCommand,
  ListCertificatesCommand,
  UploadCertificateCommand,
} from '#/modules/certificate/app/certificate.commands';
import { P12ParserAdapter } from '#/modules/certificate/infra/adapters/p12-parser.adapter';
import { S3StorageAdapter } from '#/modules/certificate/infra/adapters/s3-storage.adapter';
import { registerCertificateRoutes } from '#/modules/certificate/infra/http/certificate.routes';
import { DynamoCertificateRepository } from '#/modules/certificate/infra/persistence/dynamo-certificate.repository';
import {
  GetCompanyConfigQuery,
  SaveCompanyConfigCommand,
} from '#/modules/company-config/app/company-config.commands';
import { registerCompanyConfigRoutes } from '#/modules/company-config/infra/http/company-config.routes';
import { DynamoCompanyConfigRepository } from '#/modules/company-config/infra/persistence/dynamo-company-config.repository';
import { AuthorizeInvoiceCommand } from '#/modules/invoice/app/commands/authorize-invoice';
import { InvoiceCommand } from '#/modules/invoice/app/commands/command';
import { CreateInvoiceCommand } from '#/modules/invoice/app/commands/create-invoice';
import { SendInvoiceCommand } from '#/modules/invoice/app/commands/send-invoice';
import { SignInvoiceCommand } from '#/modules/invoice/app/commands/sign-invoice';
import { InvoiceEventHandler } from '#/modules/invoice/app/handlers/invoice-event.handler';
import { SaleConfirmedHandler } from '#/modules/invoice/app/handlers/sale-confirmed.handler';
import {
  FindInvoicesBySaleIdQuery,
  GetInvoiceQuery,
  ListInvoicesQuery,
} from '#/modules/invoice/app/queries/invoice.queries';
import { InvoiceStatus } from '#/modules/invoice/domain/invoice';
import { SignerAdapter } from '#/modules/invoice/infra/adapters/signer.adapter';
import { SriAuthorizationAdapter } from '#/modules/invoice/infra/adapters/sri-authorization.adapter';
import { SriValidationAdapter } from '#/modules/invoice/infra/adapters/sri-validation.adapter';
import { registerInvoiceRoutes } from '#/modules/invoice/infra/http/invoice.routes';
import { InvoiceKafkaConsumer } from '#/modules/invoice/infra/messaging/kafka-consumer';
import { KafkaProducer } from '#/modules/invoice/infra/messaging/kafka-producer';
import {
  InvoiceMessageSchema,
  SaleConfirmedMessageSchema,
} from '#/modules/invoice/infra/messaging/schemas';
import { KAFKA_TOPICS } from '#/modules/invoice/infra/messaging/topics';
import { DynamoInvoiceRepository } from '#/modules/invoice/infra/persistence/dynamo-invoice.repository';
import { XadesSigner } from '#/modules/invoice/infra/signing/xades-signer';
import { DlqProducer } from '#/shared/infra/dlq-producer';
import { createAuthorize } from '#/shared/infra/http/auth';
import { createHttpServer } from '#/shared/infra/http-server';
import { SoapClient } from '#/shared/infra/soap-client';

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

  const awsClientConfig = {
    region: config.aws.region,
    ...(config.aws.endpoint && { endpoint: config.aws.endpoint }),
  };

  const ddbClient = new DynamoDBClient(awsClientConfig);
  const docClient = DynamoDBDocumentClient.from(ddbClient);

  const s3Client = new S3Client({
    ...awsClientConfig,
    ...(config.aws.endpoint && { forcePathStyle: true }),
  });

  const validationClient = new SoapClient(config.externalServices.sriVoucherWsdl);
  const authorizationClient = new SoapClient(config.externalServices.sriQueryWsdl);

  // Repositories
  const invoiceRepository = new DynamoInvoiceRepository(
    docClient,
    config.aws.dynamoDb.tables.invoices,
  );
  const certificateRepository = new DynamoCertificateRepository(
    docClient,
    config.aws.dynamoDb.tables.certificates,
  );
  const companyConfigRepository = new DynamoCompanyConfigRepository(
    docClient,
    config.aws.dynamoDb.tables.companyConfig,
  );

  // Adapters
  const s3Storage = new S3StorageAdapter(s3Client, config.aws.s3.bucket, config.aws.endpoint);
  const xadesSigner = new XadesSigner(config.timezone);
  const signerAdapter = new SignerAdapter(
    certificateRepository,
    s3Storage,
    xadesSigner,
    companyConfigRepository,
    config.signing.p12Password,
  );
  const sriValidationAdapter = new SriValidationAdapter(validationClient);
  const sriAuthorizationAdapter = new SriAuthorizationAdapter(authorizationClient);

  // Producers
  const invoiceProducer = new KafkaProducer(producer, KAFKA_TOPICS.INVOICES);

  // Commands
  const signInvoiceCommand = new SignInvoiceCommand(signerAdapter, invoiceRepository);
  const sendInvoiceCommand = new SendInvoiceCommand(sriValidationAdapter, invoiceRepository);
  const authorizeInvoiceCommand = new AuthorizeInvoiceCommand(
    sriAuthorizationAdapter,
    invoiceRepository,
  );

  // Command dispatch map
  const commandMap = new Map<InvoiceStatus, InvoiceCommand>([
    [InvoiceStatus.CREATED, signInvoiceCommand],
    [InvoiceStatus.SIGNED, sendInvoiceCommand],
    [InvoiceStatus.SENT, authorizeInvoiceCommand],
  ]);

  const createInvoiceCommand = new CreateInvoiceCommand(companyConfigRepository, invoiceRepository);

  // Handlers
  const invoiceEventHandler = new InvoiceEventHandler(
    invoiceRepository,
    commandMap,
    invoiceProducer,
  );
  const saleConfirmedHandler = new SaleConfirmedHandler(createInvoiceCommand, invoiceProducer);

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
  const p12Parser = new P12ParserAdapter();

  const uploadCertificateCommand = new UploadCertificateCommand(
    p12Parser,
    s3Storage,
    certificateRepository,
  );
  const getCertificateCommand = new GetCertificateCommand(certificateRepository);
  const listCertificatesCommand = new ListCertificatesCommand(certificateRepository);
  const deleteCertificateCommand = new DeleteCertificateCommand(certificateRepository, s3Storage);

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
  const saveCompanyConfigCommand = new SaveCompanyConfigCommand(companyConfigRepository);
  const getCompanyConfigQuery = new GetCompanyConfigQuery(companyConfigRepository);

  registerCompanyConfigRoutes(
    httpServer,
    {
      save: saveCompanyConfigCommand,
      get: getCompanyConfigQuery,
    },
    authorize,
  );

  const getInvoiceQuery = new GetInvoiceQuery(invoiceRepository);
  const listInvoicesQuery = new ListInvoicesQuery(invoiceRepository);
  const findInvoicesBySaleIdQuery = new FindInvoicesBySaleIdQuery(invoiceRepository);

  registerInvoiceRoutes(
    httpServer,
    {
      get: getInvoiceQuery,
      list: listInvoicesQuery,
      findBySaleId: findInvoicesBySaleIdQuery,
    },
    authorize,
  );

  await invoiceProducer.connect();

  return { consumer: kafkaConsumer, producer: invoiceProducer, httpServer };
}
