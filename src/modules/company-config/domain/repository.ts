import { CompanyConfig, IssuerLogo } from './company-config';
import { Sequence, SequenceKey } from './sequence';

export interface CompanyConfigRepository {
  /** Saves the profile, keeping its logo: answers it as stored */
  save(config: CompanyConfig): Promise<CompanyConfig>;
  find(tenantId: string): Promise<CompanyConfig | null>;
  /** The profile with this logo; null when the company has no profile */
  setLogo(tenantId: string, logo: IssuerLogo): Promise<CompanyConfig | null>;
  /** Forgets the logo: false when the company had none */
  clearLogo(tenantId: string): Promise<boolean>;
}

/**
 * The counters of a company. Taking a number happens with the invoice that gets it
 * (InvoiceRepository.assignSequence), in the same transaction.
 */
export interface SequenceRepository {
  findAll(tenantId: string): Promise<Sequence[]>;
  /**
   * The next document of the key gets `next`, for example to continue the numbering of a previous
   * system. Never backwards: null (and nothing changes) when a later number was already issued.
   */
  setNext(key: SequenceKey, next: number): Promise<Sequence | null>;
  find(key: SequenceKey): Promise<Sequence | null>;
}
