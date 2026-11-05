import { readFileSync } from 'fs';
import { resolve } from 'path';
import { validateXML, XMLFileInfo } from 'xmllint-wasm';

import { VoucherType } from '#/modules/company-config/domain/sequence';

import { InvoiceSchemaValidator, SchemaValidationResult } from '../../domain/ports';

// resources/xsd at the root of the project: the same path from src (ts-node) and dist
const DEFAULT_XSD_DIR = resolve(__dirname, '../../../../../resources/xsd');

const SCHEMAS: Record<VoucherType, string> = {
  [VoucherType.INVOICE]: 'factura_V1.1.0.xsd',
  [VoucherType.CREDIT_NOTE]: 'notaCredito_V1.1.0.xsd',
};
// Imported by the schemas for ds:Signature
const SIGNATURE_SCHEMA = 'xmldsig-core-schema.xsd';

/**
 * Validates with libxml2 (xmllint compiled to WebAssembly) against the SRI's XSD of the document,
 * version 1.1.0. The schemas are read once; each validation runs in its own worker thread.
 */
export class XsdInvoiceSchemaValidator implements InvoiceSchemaValidator {
  private readonly schemas: Record<VoucherType, XMLFileInfo>;
  private readonly preload: XMLFileInfo;

  constructor(xsdDir: string = DEFAULT_XSD_DIR) {
    const read = (fileName: string): XMLFileInfo => ({
      fileName,
      contents: readFileSync(resolve(xsdDir, fileName), 'utf8'),
    });
    this.schemas = {
      [VoucherType.INVOICE]: read(SCHEMAS[VoucherType.INVOICE]),
      [VoucherType.CREDIT_NOTE]: read(SCHEMAS[VoucherType.CREDIT_NOTE]),
    };
    this.preload = read(SIGNATURE_SCHEMA);
  }

  async validate(
    xml: string,
    type: VoucherType = VoucherType.INVOICE,
  ): Promise<SchemaValidationResult> {
    const result = await validateXML({
      xml: { fileName: 'voucher.xml', contents: xml },
      schema: this.schemas[type],
      preload: this.preload,
    });
    return {
      valid: result.valid,
      errors: result.errors.map((error) =>
        error.loc ? `line ${error.loc.lineNumber}: ${error.message}` : error.message,
      ),
    };
  }
}
