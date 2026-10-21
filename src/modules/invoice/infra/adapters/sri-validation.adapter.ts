import { Environment } from '#/modules/company-config/domain/company-config';

import { InvoiceIssueError } from '../../domain/issue';
import { SriValidationPort } from '../../domain/ports';
import { ValidationVoucher } from '../../domain/voucher';
import {
  mapValidationVoucherToDomain,
  ReceiptVoucherResponseDTO,
} from '../mappers/sri-validation.mapper';
import { SriClients } from './sri-clients';

export class SriValidationAdapter implements SriValidationPort {
  constructor(private clients: SriClients) {}

  async validateXml(xml: string, environment: Environment): Promise<ValidationVoucher> {
    const client = this.clients.reception(environment);
    xml = Buffer.from(xml, 'utf-8').toString('base64');
    let response: { RespuestaRecepcionComprobante: ReceiptVoucherResponseDTO };
    try {
      response = (await client.callMethod('validarComprobante', {
        xml,
      })) as typeof response;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new InvoiceIssueError('SRI_UNAVAILABLE', `SRI reception service failed: ${reason}`);
    }
    return mapValidationVoucherToDomain(response.RespuestaRecepcionComprobante);
  }
}
