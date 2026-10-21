import { describe, expect, it } from 'vitest';

import { AuthError, verifyAccessToken } from '#/shared/infra/http/auth';

import { TENANT_A } from '../helpers';
import { accessToken, AUTH } from './tokens';

describe('verifyAccessToken', () => {
  it('reads the company the token was issued for (tid)', () => {
    const claims = verifyAccessToken(accessToken({ tid: TENANT_A.toUpperCase() }), AUTH);

    expect(claims).toMatchObject({ userId: '7', username: 'admin', tenantId: TENANT_A });
  });

  it.each([
    ['without tid', {}],
    ['with a tid that is not a uuid', { tid: 'default' }],
  ])('rejects a token %s, like faclab-core', (_case, claims) => {
    const verify = () => verifyAccessToken(accessToken({ tid: undefined, ...claims }), AUTH);

    expect(verify).toThrow(AuthError);
    expect(verify).toThrow(expect.objectContaining({ statusCode: 401, code: 'TENANT_REQUIRED' }));
  });
});
