/** A message of the SRI in its answers: `identificador` is its code (35, 43, 45...) */
export interface SriMessageDTO {
  identificador: string;
  mensaje: string;
  informacionAdicional?: string;
  tipo: string;
}

/**
 * The code of the first error among the SRI's messages, or of its first message when none is an
 * ERROR; null without messages
 */
export function firstErrorCode(messages: readonly SriMessageDTO[]): string | null {
  const first = messages.find((m) => m.tipo === 'ERROR') ?? messages[0];
  return first ? String(first.identificador) : null;
}
