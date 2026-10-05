export interface SummaryOptions {
  policy: string;
  stderr?: string;
  exitCode: number;
  strict?: boolean;
}
export function renderMarkdown(result: unknown, opts: SummaryOptions): string;
export function renderLog(result: unknown, opts: SummaryOptions): string[];
