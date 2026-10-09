import { SoapClient } from '#/shared/infra/soap-client';

import { InvoiceIssueError } from '../../domain/issue';
import { SriValidationPort } from '../../domain/ports';
import { ValidationVoucher } from '../../domain/voucher';
import {
  mapValidationVoucherToDomain,
  ReceiptVoucherResponseDTO,
} from '../mappers/sri-validation.mapper';

export class SriValidationAdapter implements SriValidationPort {
  constructor(private validateClient: SoapClient) {}

  async validateXml(xml: string): Promise<ValidationVoucher> {
    xml = Buffer.from(xml, 'utf-8').toString('base64');
    let response: { RespuestaRecepcionComprobante: ReceiptVoucherResponseDTO };
    try {
      response = (await this.validateClient.callMethod('validarComprobante', {
        xml,
      })) as typeof response;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new InvoiceIssueError('SRI_UNAVAILABLE', `SRI reception service failed: ${reason}`);
    }
    return mapValidationVoucherToDomain(response.RespuestaRecepcionComprobante);
  }
}
