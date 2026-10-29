import { readFileSync } from 'fs';
import { resolve } from 'path';
import { validateXML, XMLFileInfo } from 'xmllint-wasm';

import { InvoiceSchemaValidator, SchemaValidationResult } from '../../domain/ports';

// resources/xsd at the root of the project: the same path from src (ts-node) and dist
const DEFAULT_XSD_DIR = resolve(__dirname, '../../../../../resources/xsd');

const INVOICE_SCHEMA = 'factura_V1.1.0.xsd';
// Imported by the invoice schema for ds:Signature
const SIGNATURE_SCHEMA = 'xmldsig-core-schema.xsd';

/**
 * Validates with libxml2 (xmllint compiled to WebAssembly) against the SRI's invoice XSD version
 * 1.1.0. The schemas are read once; each validation runs in its own worker thread.
 */
export class XsdInvoiceSchemaValidator implements InvoiceSchemaValidator {
  private readonly schema: XMLFileInfo;
  private readonly preload: XMLFileInfo;

  constructor(xsdDir: string = DEFAULT_XSD_DIR) {
    const read = (fileName: string): XMLFileInfo => ({
      fileName,
      contents: readFileSync(resolve(xsdDir, fileName), 'utf8'),
    });
    this.schema = read(INVOICE_SCHEMA);
    this.preload = read(SIGNATURE_SCHEMA);
  }

  async validate(xml: string): Promise<SchemaValidationResult> {
    const result = await validateXML({
      xml: { fileName: 'invoice.xml', contents: xml },
      schema: this.schema,
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
