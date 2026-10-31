import { ConflictError, UnprocessableError } from '#/shared/errors/app-error';
import { logger } from '#/shared/logger';

import { CompanyConfig } from '../domain/company-config';
import {
  inspectLogo,
  issuerLogoKey,
  LOGO_MAX_BYTES,
  LOGO_MAX_PIXELS,
  LogoStore,
} from '../domain/logo';
import { CompanyConfigRepository } from '../domain/repository';

export const logoTooLarge = () =>
  new UnprocessableError(
    'LOGO_TOO_LARGE',
    `The logo must weigh at most ${LOGO_MAX_BYTES / 1024} KB`,
  );

/** Replaces the logo the company's RIDEs carry: a PNG or JPEG, checked before it is kept */
export class SetIssuerLogoCommand {
  constructor(
    private readonly repository: CompanyConfigRepository,
    private readonly store: LogoStore,
  ) {}

  async execute(tenantId: string, bytes: Buffer): Promise<CompanyConfig> {
    if (bytes.length > LOGO_MAX_BYTES) throw logoTooLarge();
    const info = inspectLogo(bytes);
    if (!info) {
      throw new UnprocessableError(
        'LOGO_INVALID',
        `The logo must be a PNG (not interlaced) or JPEG image of at most ${LOGO_MAX_PIXELS} × ${LOGO_MAX_PIXELS} pixels`,
      );
    }
    if (!(await this.repository.find(tenantId))) {
      throw new ConflictError(
        'ISSUER_NOT_CONFIGURED',
        'Save the company fiscal profile before uploading its logo',
      );
    }
    const key = issuerLogoKey(tenantId);
    // Kept first: the profile never points to a logo that isn't there
    await this.store.put(key, bytes, info.contentType);
    const config = await this.repository.setLogo(tenantId, { key, contentType: info.contentType });
    if (!config) {
      throw new ConflictError('ISSUER_NOT_CONFIGURED', 'The company fiscal profile was removed');
    }
    return config;
  }
}

/** The RIDEs go out without a logo; nothing happens if the company had none */
export class DeleteIssuerLogoCommand {
  constructor(
    private readonly repository: CompanyConfigRepository,
    private readonly store: LogoStore,
  ) {}

  async execute(tenantId: string): Promise<void> {
    if (!(await this.repository.clearLogo(tenantId))) return;
    try {
      await this.store.delete(issuerLogoKey(tenantId));
    } catch (error) {
      // The profile no longer points to it: a leftover object is harmless and the next upload
      // overwrites it
      logger.warn({ err: error }, 'The issuer logo could not be deleted from the storage');
    }
  }
}

export interface IssuerLogoFile {
  bytes: Buffer;
  contentType: string;
}

export class GetIssuerLogoQuery {
  constructor(
    private readonly repository: CompanyConfigRepository,
    private readonly store: LogoStore,
  ) {}

  /** Null when the company has no logo */
  async execute(tenantId: string): Promise<IssuerLogoFile | null> {
    const logo = (await this.repository.find(tenantId))?.logo;
    if (!logo) return null;
    const bytes = await this.store.getBytes(logo.key);
    return bytes ? { bytes, contentType: logo.contentType } : null;
  }
}
