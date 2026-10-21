import { ConflictError } from '#/shared/errors/app-error';

import { SequenceRepository } from '../domain/repository';
import { formatSequence, INVOICE_DOC_TYPE, Sequence, SequenceKey } from '../domain/sequence';

export class ListSequencesQuery {
  constructor(private readonly repository: SequenceRepository) {}

  /** The company's counters that were used or set */
  async execute(tenantId: string): Promise<Sequence[]> {
    return this.repository.findAll(tenantId);
  }
}

export interface SetNextSequenceInput {
  establishment: string;
  emissionPoint: string;
  // The number the next invoice of that establishment and emission point gets
  nextSequence: number;
}

/**
 * Sets where the invoice numbering of an emission point continues, for example after a previous
 * system. It can only move forward: the SRI rejects a number issued twice.
 */
export class SetNextSequenceCommand {
  constructor(private readonly repository: SequenceRepository) {}

  async execute(tenantId: string, input: SetNextSequenceInput): Promise<Sequence> {
    const key: SequenceKey = {
      tenantId,
      establishment: input.establishment,
      emissionPoint: input.emissionPoint,
      docType: INVOICE_DOC_TYPE,
    };
    const sequence = await this.repository.setNext(key, input.nextSequence);
    if (sequence) return sequence;

    const current = await this.repository.find(key);
    const last = current ? formatSequence(current.lastValue) : 'a later one';
    throw new ConflictError(
      'SEQUENCE_CANNOT_GO_BACK',
      `${input.establishment}-${input.emissionPoint} already issued ${last}: the next invoice can't be ${formatSequence(input.nextSequence)}`,
    );
  }
}
