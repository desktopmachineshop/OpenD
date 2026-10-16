export type Severity = 'error' | 'warning';

export interface Diagnostic {
  severity: Severity;
  /** Stable identifier, such as `missing-conref`, so tools can filter or suppress. */
  code: string;
  message: string;
  file?: string;
  line?: number;
  column?: number;
}

export function formatDiagnostic(d: Diagnostic): string {
  const where = d.file ? `${d.file}${d.line ? `:${d.line}:${d.column ?? 1}` : ''}` : '<project>';
  return `${where}: ${d.severity} [${d.code}] ${d.message}`;
}

export function hasErrors(diagnostics: readonly Diagnostic[]): boolean {
  return diagnostics.some((d) => d.severity === 'error');
}

export function sortDiagnostics(diagnostics: readonly Diagnostic[]): Diagnostic[] {
  return [...diagnostics].sort(
    (a, b) =>
      (a.file ?? '').localeCompare(b.file ?? '') ||
      (a.line ?? 0) - (b.line ?? 0) ||
      (a.column ?? 0) - (b.column ?? 0) ||
      a.code.localeCompare(b.code),
  );
}
