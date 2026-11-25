/** Who takes the company to production: the `sub` and the username of the token */
export interface ProductionActor {
  id: string;
  username: string | null;
}

export interface ProductionResult {
  // The test invoices of the onboarding that were forgotten
  removedTestInvoices: number;
  // Numbers given back to the counters the test invoices had taken
  restoredSequences: number;
}

/**
 * The step from the SRI's test environment to production (S8.5), in one transaction: the issuer's
 * environment, the counters and the test invoices of the onboarding, and the audit entry. Null (and
 * nothing changes) when the issuer isn't in the test environment any more.
 */
export interface IssuerProductionRepository {
  enterProduction(tenantId: string, actor: ProductionActor): Promise<ProductionResult | null>;
}
