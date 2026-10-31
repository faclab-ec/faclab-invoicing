import { CompanyConfigRepository } from '#/modules/company-config/domain/repository';
import { logger } from '#/shared/logger';

import { rideKey } from '../../domain/authorized-xml';
import { Invoice } from '../../domain/invoice';
import { DocumentStorage, RideRenderer } from '../../domain/ports';
import { buildRide, Ride } from '../../domain/ride';

export interface RideFile {
  // <access code>.pdf
  fileName: string;
  pdf: Buffer;
  // What it prints, e.g. for the email that carries it
  ride: Ride;
}

/**
 * The RIDE of an authorized invoice: generated once, from its authorized XML, and kept next to it
 * in the document storage. The delivery of each authorized invoice generates it; the download
 * generates the ones authorized before S4.4 when they are first asked for.
 */
export class RideService {
  constructor(
    private readonly storage: DocumentStorage,
    private readonly companyConfigs: CompanyConfigRepository,
    private readonly renderer: RideRenderer,
    private readonly timezone: string,
  ) {}

  /** Null when the invoice has no authorization (not authorized, or authorized before S4.1) */
  async ensure(invoice: Invoice): Promise<RideFile | null> {
    const { authorization, accessCode, xml } = invoice;
    if (!authorization || !accessCode || !xml) return null;
    const ride = buildRide(xml, authorization, this.timezone);
    const fileName = `${accessCode.value}.pdf`;
    const key = rideKey(invoice.tenantId, accessCode.emissionYear, accessCode.value);

    const stored = await this.storage.getBytes(key);
    if (stored) return { fileName, pdf: stored, ride };

    const pdf = await this.renderer.render(ride, await this.logoOf(invoice.tenantId));
    await this.storage.put(key, pdf, 'application/pdf');
    logger.info({ invoiceId: invoice.id }, 'RIDE generated');
    return { fileName, pdf, ride };
  }

  /** The company's logo as it is now; without it (or if it can't be read) the RIDE has none */
  private async logoOf(tenantId: string): Promise<Buffer | null> {
    const logo = (await this.companyConfigs.find(tenantId))?.logo;
    if (!logo) return null;
    try {
      return await this.storage.getBytes(logo.key);
    } catch (error) {
      logger.warn({ err: error }, 'The issuer logo could not be read: the RIDE goes without it');
      return null;
    }
  }
}
