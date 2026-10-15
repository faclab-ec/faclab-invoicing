export const SRI_ENVIRONMENTS = ['test', 'production'] as const;
export type SriEnvironment = (typeof SRI_ENVIRONMENTS)[number];

export interface SriEndpoints {
  receptionWsdl: string;
  authorizationWsdl: string;
}

// The SRI offline web services: `celcer` is the test environment, `cel` the one with tax validity.
// SRI_ENVIRONMENT picks one pair for the whole process; S2.8 moves the environment to each issuer.
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
