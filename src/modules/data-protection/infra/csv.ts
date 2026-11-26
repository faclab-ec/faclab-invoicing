/** One CSV line: comma separated, quoted when needed, dates as ISO 8601, JSON as text */
export function csvLine(values: readonly unknown[]): string {
  return `${values.map(csvCell).join(',')}\r\n`;
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text =
    value instanceof Date
      ? value.toISOString()
      : typeof value === 'object'
        ? JSON.stringify(value)
        : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
