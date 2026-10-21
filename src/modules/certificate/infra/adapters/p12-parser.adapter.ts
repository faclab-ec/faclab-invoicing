import { certificateTaxIds, formatRfc4514, parseP12 } from '#/shared/infra/p12';

import { P12Metadata, P12ParserPort } from '../../domain/ports';

export class P12ParserAdapter implements P12ParserPort {
  parse(buffer: Buffer, password: string): P12Metadata {
    const { certificate } = parseP12(buffer, password);

    return {
      serialNumber: BigInt('0x' + certificate.serialNumber).toString(),
      subject: formatRfc4514(certificate.subject.attributes),
      issuer: formatRfc4514(certificate.issuer.attributes),
      taxIds: certificateTaxIds(certificate),
      validFrom: certificate.validity.notBefore,
      validTo: certificate.validity.notAfter,
    };
  }
}
