import { CertificateKeyLoader } from '#/modules/certificate/app/certificate-key-loader';
import { Certificate } from '#/modules/certificate/domain/certificate';
import { P12ParserPort } from '#/modules/certificate/domain/ports';
import { CertificateRepository } from '#/modules/certificate/domain/repository';

import {
  CompanyConfig,
  Environment,
  SPECIAL_TAXPAYER_RESOLUTION_PATTERN,
  WITHHOLDING_AGENT_RESOLUTION_PATTERN,
} from '../domain/company-config';
import {
  IssuerNotReadyError,
  ReadinessErrorCode,
  ReadinessIssue,
  ReadinessReport,
  ReadinessWarningCode,
} from '../domain/readiness';
import { CompanyConfigRepository } from '../domain/repository';

const CACHE_TTL_MS = 60_000;
const EXPIRY_WARNING_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

// Same rules as the PUT schema: the SRI rejects anything else
// A value that doesn't fit would only fail later, in the invoice XML; null fields are left out
const CONFIG_FIELD_PATTERNS: [keyof CompanyConfig, RegExp][] = [
  ['taxId', /^\d{13}$/],
  ['specialTaxpayerResolution', SPECIAL_TAXPAYER_RESOLUTION_PATTERN],
  ['withholdingAgentResolution', WITHHOLDING_AGENT_RESOLUTION_PATTERN],
];

export interface ReadyIssuer {
  config: CompanyConfig;
  certificate: Certificate;
}

interface Evaluation {
  report: ReadinessReport;
  issuer: ReadyIssuer | null;
  at: number;
}

// One company's cached answer and the computation in progress
interface Entry {
  cached: Evaluation | null;
  running: Promise<Evaluation> | null;
  generation: number;
}

export interface ReadinessOptions {
  // False where only the SRI test environment may be reached (NODE_ENV=local)
  productionAllowed?: boolean;
  now?: () => Date;
}

const error = (code: ReadinessErrorCode, message: string): ReadinessIssue => ({
  code,
  severity: 'error',
  message,
});

const warning = (code: ReadinessWarningCode, message: string): ReadinessIssue => ({
  code,
  severity: 'warning',
  message,
});

/**
 * Whether a company's issuer can invoice: config saved and valid, an environment this deployment
 * can reach, a certificate of its RUC selected, present, not expired and readable with its stored
 * password. Each company has its own answer, cached for a minute: one that can't invoice doesn't
 * stop another. Its config and certificate changes clear it.
 */
export class IssuerReadinessService {
  private readonly entries = new Map<string, Entry>();
  private readonly productionAllowed: boolean;
  private readonly now: () => Date;

  constructor(
    private readonly companyConfigRepository: CompanyConfigRepository,
    private readonly certificateRepository: CertificateRepository,
    private readonly keyLoader: CertificateKeyLoader,
    private readonly p12Parser: P12ParserPort,
    options: ReadinessOptions = {},
  ) {
    this.productionAllowed = options.productionAllowed ?? true;
    this.now = options.now ?? (() => new Date());
  }

  async check(tenantId: string): Promise<ReadinessReport> {
    return (await this.evaluate(tenantId)).report;
  }

  /** The company's config and certificate to invoice with; IssuerNotReadyError otherwise */
  async requireReady(tenantId: string): Promise<ReadyIssuer> {
    const { report, issuer } = await this.evaluate(tenantId);
    if (issuer) return issuer;
    const blocking = report.issues.find((issue) => issue.severity === 'error');
    // Not ready always comes with at least one error
    throw new IssuerNotReadyError(
      (blocking?.code ?? 'CONFIG_MISSING') as ReadinessErrorCode,
      blocking?.message ?? 'The issuer is not ready',
    );
  }

  /** Forgets the company's answer (every company's, without `tenantId`) */
  invalidate(tenantId?: string): void {
    const entries =
      tenantId === undefined ? [...this.entries.values()] : [this.entries.get(tenantId)];
    for (const entry of entries) {
      if (!entry) continue;
      entry.cached = null;
      entry.running = null;
      entry.generation += 1;
    }
  }

  private evaluate(tenantId: string): Promise<Evaluation> {
    let entry = this.entries.get(tenantId);
    if (!entry) {
      entry = { cached: null, running: null, generation: 0 };
      this.entries.set(tenantId, entry);
    }
    const { cached } = entry;
    if (cached && this.now().getTime() - cached.at < CACHE_TTL_MS) {
      return Promise.resolve(cached);
    }
    if (entry.running) return entry.running;

    const current = entry;
    const generation = current.generation;
    const running = this.compute(tenantId).then((evaluation) => {
      // A change while computing makes this result stale: don't keep it
      if (generation === current.generation) current.cached = evaluation;
      return evaluation;
    });
    const clear = () => {
      if (current.running === running) current.running = null;
    };
    running.then(clear, clear);
    current.running = running;
    return running;
  }

  private async compute(tenantId: string): Promise<Evaluation> {
    const now = this.now();
    const at = now.getTime();
    const issues: ReadinessIssue[] = [];

    const config = await this.companyConfigRepository.find(tenantId);
    if (!config) {
      issues.push(error('CONFIG_MISSING', 'The company fiscal config has not been saved'));
      return {
        report: { ready: false, taxId: null, environment: null, certificate: null, issues },
        issuer: null,
        at,
      };
    }

    const invalidFields = CONFIG_FIELD_PATTERNS.filter(
      ([field, pattern]) => config[field] !== null && !pattern.test(String(config[field])),
    ).map(([field]) => field);
    if (invalidFields.length > 0) {
      issues.push(
        error('CONFIG_INVALID', `Invalid company config fields: ${invalidFields.join(', ')}`),
      );
    }
    if (config.environment === Environment.PRODUCTION && !this.productionAllowed) {
      issues.push(
        error(
          'ENVIRONMENT_NOT_ALLOWED',
          'This deployment only reaches the SRI test environment: set the issuer to testing (1)',
        ),
      );
    }
    if (config.environment === Environment.TESTING) {
      issues.push(warning('TEST_ENVIRONMENT', 'Invoices are issued in the SRI test environment'));
    }

    const certificate = await this.checkCertificate(config, now, issues);
    const ready = !issues.some((issue) => issue.severity === 'error');

    return {
      report: {
        ready,
        taxId: config.taxId,
        environment: config.environment,
        certificate: certificate && {
          id: certificate.id,
          subject: certificate.subject,
          validTo: certificate.validTo,
        },
        issues,
      },
      issuer: ready && certificate ? { config, certificate } : null,
      at,
    };
  }

  private async checkCertificate(
    config: CompanyConfig,
    now: Date,
    issues: ReadinessIssue[],
  ): Promise<Certificate | null> {
    if (!config.signingCertId) {
      issues.push(
        error('CERTIFICATE_NOT_SELECTED', 'No signing certificate is selected in the config'),
      );
      return null;
    }

    const certificate = await this.certificateRepository.findById(
      config.tenantId,
      config.signingCertId,
    );
    if (!certificate) {
      issues.push(
        error('CERTIFICATE_NOT_FOUND', `Signing certificate ${config.signingCertId} not found`),
      );
      return null;
    }

    if (certificate.isExpired(now)) {
      issues.push(
        error(
          'CERTIFICATE_EXPIRED',
          `The signing certificate expired on ${certificate.validTo.toISOString()}`,
        ),
      );
      return certificate;
    }

    // The profile's RUC changed after the certificate was selected
    if (!certificate.belongsTo(config.taxId)) {
      issues.push(
        error(
          'CERTIFICATE_RUC_MISMATCH',
          `The signing certificate belongs to ${certificate.taxIds.join(', ')}, not to the RUC ${config.taxId}`,
        ),
      );
      return certificate;
    }

    const daysLeft = Math.floor((certificate.validTo.getTime() - now.getTime()) / DAY_MS);
    if (daysLeft <= EXPIRY_WARNING_DAYS) {
      issues.push(
        warning('CERTIFICATE_EXPIRING_SOON', `The signing certificate expires in ${daysLeft} days`),
      );
    }

    try {
      const key = await this.keyLoader.load(certificate);
      this.p12Parser.parse(key.p12, key.password);
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      issues.push(
        error('CERTIFICATE_UNREADABLE', `The signing certificate can't be opened: ${reason}`),
      );
    }
    return certificate;
  }
}
