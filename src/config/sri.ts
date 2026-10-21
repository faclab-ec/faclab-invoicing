export const SRI_ENVIRONMENTS = ['test', 'production'] as const;
export type SriEnvironment = (typeof SRI_ENVIRONMENTS)[number];

export interface SriEndpoints {
  receptionWsdl: string;
  authorizationWsdl: string;
}

// The SRI offline web services: `celcer` is the test environment, `cel` the one with tax validity.
// Each issuer's environment picks the pair its invoices go to; only NODE_ENV=production reaches `cel`.
export const SRI_ENDPOINTS: Record<SriEnvironment, SriEndpoints> = {
  test: {
    receptionWsdl:
      'https://celcer.sri.gob.ec/comprobantes-electronicos-ws/RecepcionComprobantesOffline?wsdl',
    authorizationWsdl:
      'https://celcer.sri.gob.ec/comprobantes-electronicos-ws/AutorizacionComprobantesOffline?wsdl',
  },
  production: {
    receptionWsdl:
      'https://cel.sri.gob.ec/comprobantes-electronicos-ws/RecepcionComprobantesOffline?wsdl',
    authorizationWsdl:
      'https://cel.sri.gob.ec/comprobantes-electronicos-ws/AutorizacionComprobantesOffline?wsdl',
  },
};
