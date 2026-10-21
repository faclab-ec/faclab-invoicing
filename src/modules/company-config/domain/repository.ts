import { CompanyConfig } from './company-config';
import { Sequence, SequenceKey } from './sequence';

export interface CompanyConfigRepository {
  save(config: CompanyConfig): Promise<CompanyConfig>;
  find(tenantId: string): Promise<CompanyConfig | null>;
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
