import { CertificateKeyLoader } from '#/modules/certificate/app/certificate-key-loader';
import { Certificate } from '#/modules/certificate/domain/certificate';
import { P12ParserPort } from '#/modules/certificate/domain/ports';
import { CertificateRepository } from '#/modules/certificate/domain/repository';

import { CompanyConfig, Environment } from '../domain/company-config';
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
const CONFIG_FIELD_PATTERNS: [keyof CompanyConfig, RegExp][] = [
  ['taxId', /^\d{13}$/],
  ['branchCode', /^\d{3}$/],
  ['salePointCode', /^\d{3}$/],
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
 * Whether the issuer can invoice: config saved and valid, a certificate
 * selected, present, not expired and readable with its stored password. The
 * result is cached for a minute; config and certificate changes clear it.
 */
export class IssuerReadinessService {
  private cached: Evaluation | null = null;
  private running: Promise<Evaluation> | null = null;
  private generation = 0;

  constructor(
    private readonly companyConfigRepository: CompanyConfigRepository,
    private readonly certificateRepository: CertificateRepository,
    private readonly keyLoader: CertificateKeyLoader,
    private readonly p12Parser: P12ParserPort,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async check(): Promise<ReadinessReport> {
    return (await this.evaluate()).report;
  }

  /** The config and certificate to invoice with; IssuerNotReadyError otherwise */
  async requireReady(): Promise<ReadyIssuer> {
    const { report, issuer } = await this.evaluate();
    if (issuer) return issuer;
    const blocking = report.issues.find((issue) => issue.severity === 'error');
    // Not ready always comes with at least one error
    throw new IssuerNotReadyError(
      (blocking?.code ?? 'CONFIG_MISSING') as ReadinessErrorCode,
      blocking?.message ?? 'The issuer is not ready',
    );
  }

  invalidate(): void {
    this.cached = null;
    this.running = null;
    this.generation += 1;
  }

  private evaluate(): Promise<Evaluation> {
    if (this.cached && this.now().getTime() - this.cached.at < CACHE_TTL_MS) {
      return Promise.resolve(this.cached);
    }
    if (!this.running) {
      const generation = this.generation;
      const running = this.compute().then((evaluation) => {
        // A change while computing makes this result stale: don't keep it
        if (generation === this.generation) this.cached = evaluation;
        return evaluation;
      });
      const clear = () => {
        if (this.running === running) this.running = null;
      };
      running.then(clear, clear);
      this.running = running;
    }
    return this.running;
  }

  private async compute(): Promise<Evaluation> {
    const now = this.now();
    const at = now.getTime();
    const issues: ReadinessIssue[] = [];

    const config = await this.companyConfigRepository.find();
    if (!config) {
      issues.push(error('CONFIG_MISSING', 'The company fiscal config has not been saved'));
      return {
        report: { ready: false, environment: null, certificate: null, issues },
        issuer: null,
        at,
      };
    }

    const invalidFields = CONFIG_FIELD_PATTERNS.filter(
      ([field, pattern]) => !pattern.test(String(config[field])),
    ).map(([field]) => field);
    if (invalidFields.length > 0) {
      issues.push(
        error('CONFIG_INVALID', `Invalid company config fields: ${invalidFields.join(', ')}`),
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

    const certificate = await this.certificateRepository.findById(config.signingCertId);
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
