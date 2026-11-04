import { describe, expect, it } from 'vitest';

import { consumerOptions } from '#/shared/infra/kafka';

describe('consumerOptions', () => {
  it('reads a partition without a committed offset from the beginning', () => {
    // The default takes only new messages: what arrives while the service is down would be lost,
    // like the first message of a new topic or of a company in a partition
    expect(consumerOptions('faclab-invoicing').fromBeginning).toBe(true);
  });

  it('commits by hand, after processing or keeping a dead letter', () => {
    expect(consumerOptions('faclab-invoicing')).toMatchObject({
      groupId: 'faclab-invoicing',
      autoCommit: false,
    });
  });
});
