import { FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import { Pool, PoolClient } from 'pg';

import { AppError } from '#/shared/errors/app-error';
import { withTransaction } from '#/shared/infra/database';
import { logger } from '#/shared/logger';

// Rate limits of the public API (S6.3, D-6), as faclab-core counts them for its own routes: each
// key (an integration client, its company) has a GCRA bucket that sustains `perMinute` requests
// and takes up to `burst` at once. Its state is one number, the theoretical arrival time (TAT):
// when its bucket is empty again. Each service counts the requests to its own routes.

export interface RateLimit {
  perMinute: number;
  burst: number;
}

export interface Decision {
  allowed: boolean;
  limit: RateLimit;
  remaining: number;
  // Seconds until the bucket is full again
  reset: number;
  // When refused: seconds until a request fits
  retryAfter: number;
}

// Floating point slack: the burst-th request of a full bucket must fit
const EPSILON = 1e-9;

const interval = (limit: RateLimit) => 60 / limit.perMinute;
const capacity = (limit: RateLimit) => interval(limit) * limit.burst;
const seconds = (value: number) => Math.ceil(Number(value.toFixed(6)));

/** `RateLimit-Policy`: `burst` requests in the window the bucket takes to fill again */
export const policyOf = (limit: RateLimit) =>
  `${limit.burst};w=${Math.max(1, Math.round(capacity(limit)))}`;

/** The decision on a request to a key whose TAT is `tat` (null: never used) and the TAT it leaves */
export function admit(
  limit: RateLimit,
  tat: number | null,
  now: number,
): { decision: Decision; tat: number } {
  const current = Math.max(tat ?? now, now);
  const moved = current + interval(limit);
  if (moved - now > capacity(limit) + EPSILON) {
    return {
      decision: {
        allowed: false,
        limit,
        remaining: 0,
        reset: seconds(current - now),
        retryAfter: Math.max(1, seconds(moved - capacity(limit) - now)),
      },
      tat: current,
    };
  }
  return {
    decision: {
      allowed: true,
      limit,
      remaining: Math.floor(
        Number(((capacity(limit) - (moved - now)) / interval(limit)).toFixed(6)),
      ),
      reset: seconds(moved - now),
      retryAfter: 0,
    },
    tat: moved,
  };
}

/** What the response reports: the refused decision, or the key with the fewest requests left */
export function binding(decisions: Decision[]): Decision {
  const refused = decisions.filter((d) => !d.allowed);
  if (refused.length > 0) {
    return refused.reduce((a, b) => (b.retryAfter > a.retryAfter ? b : a));
  }
  return decisions.reduce((a, b) => (b.remaining < a.remaining ? b : a));
}

export interface RateLimiter {
  /** Counts a request against each key in order, stopping at the first that refuses it */
  check(keys: [string, RateLimit][]): Promise<Decision>;
}

/**
 * The counters in `api_rate_limits`: each key moves its TAT in one upsert, only when the request
 * fits, so every process shares them and two requests never both take the last place.
 */
export class PgRateLimiter implements RateLimiter {
  constructor(
    private readonly pool: Pool,
    private readonly clock: () => number = () => Date.now() / 1000,
  ) {}

  async check(keys: [string, RateLimit][]): Promise<Decision> {
    return withTransaction(this.pool, async (client) => {
      const decisions: Decision[] = [];
      for (const [key, limit] of keys) {
        const decision = await this.count(client, key, limit, this.clock());
        decisions.push(decision);
        if (!decision.allowed) break;
      }
      return binding(decisions);
    });
  }

  private async count(
    client: PoolClient,
    key: string,
    limit: RateLimit,
    now: number,
  ): Promise<Decision> {
    const step = interval(limit);
    const moved = await client.query<{ tat: number }>(
      `INSERT INTO api_rate_limits (key, tat) VALUES ($1, $2::float8 + $3::float8)
       ON CONFLICT (key) DO UPDATE SET tat = greatest(api_rate_limits.tat, $2::float8) + $3::float8
       WHERE greatest(api_rate_limits.tat, $2::float8) + $3::float8 - $2::float8 <= $4::float8
       RETURNING tat`,
      [key, now, step, capacity(limit) + EPSILON],
    );
    if (moved.rows[0]) return admit(limit, Number(moved.rows[0].tat) - step, now).decision;
    const current = await client.query<{ tat: number }>(
      'SELECT tat FROM api_rate_limits WHERE key = $1',
      [key],
    );
    return admit(limit, current.rows[0] ? Number(current.rows[0].tat) : null, now).decision;
  }
}

/** Deletes the keys whose bucket is full again: they say nothing more than no row */
export async function purgeRateLimits(
  pool: Pool,
  now: number = Date.now() / 1000,
): Promise<number> {
  const result = await pool.query('DELETE FROM api_rate_limits WHERE tat < $1', [now]);
  return result.rowCount ?? 0;
}

export class RateLimitedError extends AppError {
  readonly statusCode = 429;
  readonly code = 'RATE_LIMITED';
}

export interface RateLimits {
  client: RateLimit;
  tenant: RateLimit;
}

function setHeaders(reply: FastifyReply, decision: Decision): void {
  reply.header('RateLimit-Limit', String(decision.limit.burst));
  reply.header('RateLimit-Remaining', String(decision.remaining));
  reply.header('RateLimit-Reset', String(decision.reset));
  reply.header('RateLimit-Policy', policyOf(decision.limit));
}

/**
 * preHandler of the public API, after its scope check: counts the request against its client's
 * limit and its company's. Over one: 429 `RATE_LIMITED` with `Retry-After`. If the store fails,
 * the request goes on: the limit protects the service, it never takes it down.
 */
export function createRateLimit(
  limiter: RateLimiter | null,
  limits: RateLimits,
): preHandlerAsyncHookHandler {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const integration = request.auth?.integration;
    if (!limiter || !request.auth || !integration) return;
    const tenantId = request.auth.tenantId;
    let decision: Decision;
    try {
      decision = await limiter.check([
        [`client:${tenantId}:${integration.clientId}`, limits.client],
        [`tenant:${tenantId}`, limits.tenant],
      ]);
    } catch (error) {
      logger.error({ err: error, clientId: integration.clientId }, 'Rate limit check failed');
      return;
    }
    setHeaders(reply, decision);
    if (!decision.allowed) {
      reply.header('Retry-After', String(decision.retryAfter));
      throw new RateLimitedError(`Too many requests: retry in ${decision.retryAfter} seconds`);
    }
  };
}
