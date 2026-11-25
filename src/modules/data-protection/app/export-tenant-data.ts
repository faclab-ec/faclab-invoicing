import { once } from 'events';
import { createWriteStream, WriteStream } from 'fs';
import { mkdir, writeFile } from 'fs/promises';
import { dirname, join } from 'path';

import { RideService } from '#/modules/invoice/app/services/ride-service';
import { authorizedXmlKey } from '#/modules/invoice/domain/authorized-xml';
import { Invoice } from '#/modules/invoice/domain/invoice';
import { DocumentStorage } from '#/modules/invoice/domain/ports';
import { InvoiceRepository } from '#/modules/invoice/domain/repository';
import { logger } from '#/shared/logger';

import { csvLine } from '../infra/csv';
import { PgTenantDataRepository } from '../infra/pg-tenant-data.repository';

// So Excel reads the accents
const BOM = String.fromCharCode(0xfeff);

export interface ExportResult {
  directory: string;
  rows: Record<string, number>;
  files: { xml: number; ride: number; logo: number };
  /** Documents whose XML or RIDE could not be written, by access code */
  failed: string[];
}

/**
 * The export of a company's data (S8.7, LOPDP: access and portability) as a folder in open
 * formats: a CSV per kind of record, the fiscal profile as JSON, and the authorized XML and RIDE
 * (PDF) of each authorized document. The operator zips it and hands it over
 * (docs/offboarding-runbook.md in faclab-core). Nothing of another company, and no secret: the
 * certificates come as metadata, without the .p12 nor its password.
 */
export class ExportTenantData {
  constructor(
    private readonly data: PgTenantDataRepository,
    private readonly invoices: InvoiceRepository,
    private readonly storage: DocumentStorage,
    private readonly rides: RideService,
  ) {}

  async execute(tenantId: string, outDir: string, by: string): Promise<ExportResult> {
    const issuer = await this.data.issuer(tenantId);
    if (!issuer) throw new Error('The company has no issuer profile here');
    const directory = join(outDir, `faclab-invoicing-${String(issuer.tax_id)}`);
    await mkdir(directory, { recursive: true });
    const rows: Record<string, number> = {};

    await writeFile(join(directory, 'issuer.json'), JSON.stringify(issuer, null, 2));
    rows.issuer = 1;
    rows.certificates = await this.csv(
      directory,
      'certificates',
      await this.data.certificates(tenantId),
    );
    rows.sequences = await this.csv(directory, 'sequences', await this.data.sequences(tenantId));
    rows.issuer_audit = await this.csv(directory, 'issuer-audit', await this.data.audit(tenantId));
    rows.invoices = await this.csvPages(directory, 'invoices', this.data.invoices(tenantId));
    rows.invoice_deliveries = await this.csvPages(
      directory,
      'invoice-deliveries',
      this.data.deliveries(tenantId),
    );

    const files = { xml: 0, ride: 0, logo: 0 };
    const failed: string[] = [];
    for (const { id, accessCode } of await this.data.authorizedIds(tenantId)) {
      try {
        const invoice = await this.invoices.getInvoiceById(id);
        if (!invoice) continue;
        await this.copyDocument(directory, invoice, accessCode, files);
      } catch (error) {
        // The type only: the message of a storage or SRI error can quote the document
        logger.warn(
          { event: 'data_export.document_failed', errorType: (error as Error).name },
          'A document could not be exported',
        );
        failed.push(accessCode);
      }
    }
    files.logo = await this.copyLogo(directory, issuer.logo_key as string | null);

    const result: ExportResult = { directory, rows, files, failed };
    await writeFile(
      join(directory, 'manifest.json'),
      JSON.stringify(
        {
          format: 'faclab-invoicing-export',
          version: 1,
          generatedAt: new Date().toISOString(),
          requestedBy: by,
          tenant: { id: tenantId, ruc: issuer.tax_id, legalName: issuer.name },
          encoding: 'UTF-8, comma separated, dates ISO 8601',
          rows,
          files,
          failed,
          excluded: [
            'certificates: .p12 and its password',
            'dead_letters',
            'invoices.xml of a draft',
          ],
          note: 'The sales, customers and accounting of the company are in the export of faclab-core.',
        },
        null,
        2,
      ),
    );
    logger.info(
      { event: 'data_export.done', rows, files, failed: failed.length },
      'Company data exported',
    );
    return result;
  }

  private async copyDocument(
    directory: string,
    invoice: Invoice,
    accessCode: string,
    files: { xml: number; ride: number },
  ): Promise<void> {
    const year = invoice.accessCode?.emissionYear;
    if (!year) return;
    const xml = await this.storage.getBytes(authorizedXmlKey(invoice.tenantId, year, accessCode));
    if (xml) {
      await write(join(directory, 'xml', `${accessCode}.xml`), xml);
      files.xml += 1;
    }
    // Generated now when it was never asked for: the RIDE is a view of the authorized XML
    const ride = await this.rides.ensure(invoice);
    if (ride) {
      await write(join(directory, 'ride', ride.fileName), ride.pdf);
      files.ride += 1;
    }
  }

  private async copyLogo(directory: string, key: string | null): Promise<number> {
    if (!key) return 0;
    const logo = await this.storage.getBytes(key);
    if (!logo) return 0;
    await write(join(directory, 'logo'), logo);
    return 1;
  }

  private async csv(
    directory: string,
    name: string,
    rows: Record<string, unknown>[],
  ): Promise<number> {
    return this.csvPages(
      directory,
      name,
      (async function* () {
        yield rows;
      })(),
    );
  }

  private async csvPages(
    directory: string,
    name: string,
    pages: AsyncGenerator<Record<string, unknown>[]>,
  ): Promise<number> {
    const stream: WriteStream = createWriteStream(join(directory, `${name}.csv`));
    let header: string[] | null = null;
    let count = 0;
    for await (const page of pages) {
      for (const row of page) {
        if (!header) {
          header = Object.keys(row);
          stream.write(`${BOM}${csvLine(header)}`);
        }
        if (!stream.write(csvLine(header.map((column) => row[column])))) {
          await once(stream, 'drain');
        }
        count += 1;
      }
    }
    // An empty table still has a file, with no header to name: its columns are in the schema
    stream.end();
    await once(stream, 'close');
    return count;
  }
}

async function write(path: string, body: Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, body);
}
