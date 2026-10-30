/* global Element */
import { DOMParser } from '@xmldom/xmldom';
import { DateTime } from 'luxon';

import {
  FORMA_PAGO_LABELS,
  IVA_EXEMPT_CODE,
  IVA_NOT_TAXED_CODE,
  ivaRateLabel,
} from './sri-catalogs';

// IVA (Tabla 16): the only tax the invoices carry
const IVA_TAX_CODE = '2';
// The general rate: its subtotal and its IVA always show, even at zero
const GENERAL_RATE = '15%';

const ENVIRONMENTS: Record<string, string> = { '1': 'PRUEBAS', '2': 'PRODUCCIÓN' };
const EMISSION_TYPES: Record<string, string> = { '1': 'NORMAL' };
const ELEMENT_NODE = 1;

export interface RideIssuer {
  name: string;
  tradeName: string | null;
  ruc: string;
  mainAddress: string;
  branchAddress: string | null;
  specialTaxpayer: string | null;
  accountingRequired: string;
  withholdingAgent: string | null;
  rimpe: string | null;
}

export interface RideBuyer {
  name: string;
  identification: string;
  address: string | null;
  issueDate: string;
}

export interface RideLine {
  mainCode: string;
  auxiliaryCode: string | null;
  description: string;
  details: string | null;
  quantity: string;
  unitPrice: string;
  discount: string;
  total: string;
}

export interface RideAmount {
  label: string;
  value: string;
}

export interface RidePayment {
  description: string;
  amount: string;
  term: string | null;
}

/**
 * What the RIDE (Representación Impresa del Documento Electrónico) prints, as text: everything
 * comes from the XML the SRI authorized plus its authorization, so the RIDE says exactly what was
 * authorized even if the issuer's profile changed later.
 */
export interface Ride {
  issuer: RideIssuer;
  documentType: 'FACTURA';
  // 001-001-000000123
  documentNumber: string;
  authorizationNumber: string;
  authorizedAt: string;
  environment: string;
  // Issued in the SRI's testing environment: no tax validity
  isTest: boolean;
  emission: string;
  accessCode: string;
  buyer: RideBuyer;
  lines: RideLine[];
  totals: RideAmount[];
  total: string;
  payments: RidePayment[];
  additionalInfo: RideAmount[];
}

export interface RideAuthorization {
  number: string;
  authorizedAt: Date;
}

/** The RIDE of a signed invoice XML (factura 1.1.0) and its authorization, in `timezone` */
export function buildRide(
  signedXml: string,
  authorization: RideAuthorization,
  timezone: string,
): Ride {
  const factura = parseFactura(signedXml);
  const tributaria = required(factura, 'infoTributaria');
  const info = required(factura, 'infoFactura');
  const ambiente = requiredText(tributaria, 'ambiente');

  return {
    issuer: {
      name: requiredText(tributaria, 'razonSocial'),
      tradeName: text(tributaria, 'nombreComercial'),
      ruc: requiredText(tributaria, 'ruc'),
      mainAddress: requiredText(tributaria, 'dirMatriz'),
      branchAddress: text(info, 'dirEstablecimiento'),
      specialTaxpayer: text(info, 'contribuyenteEspecial'),
      accountingRequired: text(info, 'obligadoContabilidad') ?? 'NO',
      withholdingAgent: text(tributaria, 'agenteRetencion'),
      rimpe: text(tributaria, 'contribuyenteRimpe'),
    },
    documentType: 'FACTURA',
    documentNumber: [
      requiredText(tributaria, 'estab'),
      requiredText(tributaria, 'ptoEmi'),
      requiredText(tributaria, 'secuencial'),
    ].join('-'),
    authorizationNumber: authorization.number,
    authorizedAt: DateTime.fromJSDate(authorization.authorizedAt)
      .setZone(timezone)
      .toFormat('dd/MM/yyyy HH:mm:ss'),
    environment: ENVIRONMENTS[ambiente] ?? ambiente,
    isTest: ambiente === '1',
    emission: EMISSION_TYPES[requiredText(tributaria, 'tipoEmision')] ?? 'NORMAL',
    accessCode: requiredText(tributaria, 'claveAcceso'),
    buyer: {
      name: requiredText(info, 'razonSocialComprador'),
      identification: requiredText(info, 'identificacionComprador'),
      address: text(info, 'direccionComprador'),
      issueDate: requiredText(info, 'fechaEmision'),
    },
    lines: children(required(factura, 'detalles'), 'detalle').map(toLine),
    totals: totalsOf(info),
    total: money(requiredText(info, 'importeTotal')),
    payments: children(child(info, 'pagos'), 'pago').map(toPayment),
    additionalInfo: children(child(factura, 'infoAdicional'), 'campoAdicional').map((campo) => ({
      label: campo.getAttribute('nombre') ?? '',
      value: campo.textContent?.trim() ?? '',
    })),
  };
}

function toLine(detalle: Element): RideLine {
  const details = children(child(detalle, 'detallesAdicionales'), 'detAdicional')
    .map((det) => `${det.getAttribute('nombre')}: ${det.getAttribute('valor')}`)
    .join(' · ');
  return {
    mainCode: requiredText(detalle, 'codigoPrincipal'),
    auxiliaryCode: text(detalle, 'codigoAuxiliar'),
    description: requiredText(detalle, 'descripcion'),
    details: details || null,
    quantity: decimal(requiredText(detalle, 'cantidad')),
    unitPrice: decimal(requiredText(detalle, 'precioUnitario')),
    discount: money(requiredText(detalle, 'descuento')),
    total: money(requiredText(detalle, 'precioTotalSinImpuesto')),
  };
}

function toPayment(pago: Element): RidePayment {
  const code = requiredText(pago, 'formaPago');
  const plazo = text(pago, 'plazo');
  return {
    description: FORMA_PAGO_LABELS[code] ?? code,
    amount: money(requiredText(pago, 'total')),
    term: plazo ? `${plazo} ${(text(pago, 'unidadTiempo') ?? '').toLowerCase()}`.trim() : null,
  };
}

/**
 * The SRI's summary: subtotals by rate (the general rate, 0%, not taxed and exempt always; other
 * rates when the invoice has them), then discount, the IVA of each taxed rate, tip and total.
 */
function totalsOf(info: Element): RideAmount[] {
  const subtotals = new Map<string, number>([
    [GENERAL_RATE, 0],
    ['0%', 0],
  ]);
  const ivas = new Map<string, number>([[GENERAL_RATE, 0]]);
  let notTaxed = 0;
  let exempt = 0;

  for (const impuesto of children(child(info, 'totalConImpuestos'), 'totalImpuesto')) {
    if (requiredText(impuesto, 'codigo') !== IVA_TAX_CODE) continue;
    const code = Number(requiredText(impuesto, 'codigoPorcentaje'));
    const base = cents(requiredText(impuesto, 'baseImponible'));
    const value = cents(requiredText(impuesto, 'valor'));
    if (code === IVA_NOT_TAXED_CODE) {
      notTaxed += base;
      continue;
    }
    if (code === IVA_EXEMPT_CODE) {
      exempt += base;
      continue;
    }
    const rate = ivaRateLabel(code) ?? `código ${code}`;
    subtotals.set(rate, (subtotals.get(rate) ?? 0) + base);
    if (rate !== '0%') ivas.set(rate, (ivas.get(rate) ?? 0) + value);
  }

  return [
    ...[...subtotals].map(([rate, value]) => amount(`SUBTOTAL ${rate}`, value)),
    amount('SUBTOTAL NO OBJETO DE IVA', notTaxed),
    amount('SUBTOTAL EXENTO DE IVA', exempt),
    { label: 'SUBTOTAL SIN IMPUESTOS', value: money(requiredText(info, 'totalSinImpuestos')) },
    { label: 'TOTAL DESCUENTO', value: money(requiredText(info, 'totalDescuento')) },
    ...[...ivas].map(([rate, value]) => amount(`IVA ${rate}`, value)),
    { label: 'PROPINA', value: money(text(info, 'propina') ?? '0') },
    { label: 'VALOR TOTAL', value: money(requiredText(info, 'importeTotal')) },
  ];
}

function parseFactura(xml: string): Element {
  const errors: string[] = [];
  const document = new DOMParser({
    errorHandler: {
      warning: () => {},
      error: (message) => errors.push(message),
      fatalError: (message) => errors.push(message),
    },
  }).parseFromString(xml, 'text/xml');
  const root = document.documentElement;
  if (errors.length > 0 || !root || root.localName !== 'factura') {
    throw new Error(`Not an invoice XML${errors.length > 0 ? `: ${errors[0]}` : ''}`);
  }
  return root;
}

// Direct children by local name: the signature (ds:) and its descendants never match
function children(parent: Element | null, name: string): Element[] {
  if (!parent) return [];
  const found: Element[] = [];
  for (let node = parent.firstChild; node; node = node.nextSibling) {
    if (node.nodeType === ELEMENT_NODE && (node as Element).localName === name) {
      found.push(node as Element);
    }
  }
  return found;
}

function child(parent: Element, name: string): Element | null {
  return children(parent, name)[0] ?? null;
}

function required(parent: Element, name: string): Element {
  const element = child(parent, name);
  if (!element) throw new Error(`The invoice XML has no ${name}`);
  return element;
}

function text(parent: Element, name: string): string | null {
  const value = child(parent, name)?.textContent?.trim();
  return value ? value : null;
}

function requiredText(parent: Element, name: string): string {
  const value = text(parent, name);
  if (value === null) throw new Error(`The invoice XML has no ${name}`);
  return value;
}

// Money adds up in whole cents, as the XML builder does
function cents(value: string): number {
  return Math.round(Number(value) * 100);
}

function amount(label: string, valueInCents: number): RideAmount {
  return { label, value: (valueInCents / 100).toFixed(2) };
}

function money(value: string): string {
  return (cents(value) / 100).toFixed(2);
}

/** A quantity or unit price as the XML has it (up to 6 decimals), with at least 2 */
function decimal(value: string): string {
  const [whole, fraction = ''] = value.split('.');
  return `${whole}.${fraction.padEnd(2, '0')}`;
}
