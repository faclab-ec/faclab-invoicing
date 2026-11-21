import { Environment } from '#/modules/company-config/domain/company-config';

import { SriValidationPort } from '../../domain/ports';
import { ValidationVoucher, ValidationVoucherStatus } from '../../domain/voucher';
import {
  mapValidationVoucherToDomain,
  ReceiptVoucherResponseDTO,
  receptionErrorCode,
} from '../mappers/sri-validation.mapper';
import { callSri } from './sri-call';
import { SriClients } from './sri-clients';

export class SriValidationAdapter implements SriValidationPort {
  constructor(private clients: SriClients) {}

  async validateXml(xml: string, environment: Environment): Promise<ValidationVoucher> {
    const client = this.clients.reception(environment);
    return callSri(
      {
        operation: 'recepcion',
        environment,
        client,
        method: 'validarComprobante',
        args: { xml: Buffer.from(xml, 'utf-8').toString('base64') },
      },
      (response: { RespuestaRecepcionComprobante: ReceiptVoucherResponseDTO }) => {
        const dto = response.RespuestaRecepcionComprobante;
        const voucher = mapValidationVoucherToDomain(dto);
        // Returned only because the SRI already has it (43, 70): not a rejection
        const rejected =
          voucher.status === ValidationVoucherStatus.REJECTED && !voucher.alreadyReceived;
        return {
          result: voucher,
          status: dto.estado,
          rejectionCode: rejected ? receptionErrorCode(dto) : undefined,
        };
      },
    );
  }
}
