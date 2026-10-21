import type { PipelineState, StageTelemetry, StageTokenUsage } from '../types/pipeline.types.ts';

// ---------------------------------------------------------------------------
// Cost report — what one work item's pipeline runs used, stage by stage.
//
// Reads only `state.telemetry`. `costUsd` is what the Claude Agent SDK reports:
// the API list price of the tokens. On a subscription token it is an
// equivalent, not a bill.
// ---------------------------------------------------------------------------

export interface CostRow {
  /** Stage or sub-agent name; sub-agents are indented under their stage. */
  name: string;
  subAgent: boolean;
  model: string;
  turns: number;
  durationMs: number;
  tokens?: StageTokenUsage;
  /** Undefined for sub-agents: the SDK reports cost per run and per model, not per sub-agent. */
  costUsd?: number;
  startedAt?: string;
  subtype?: string;
}

export interface CostReport {
  workItemId: number;
  status: string;
  rows: CostRow[];
  total: { costUsd: number; durationMs: number; turns: number; tokens: StageTokenUsage; runs: number };
}

const ZERO: StageTokenUsage = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };

function addTokens(a: StageTokenUsage, b: StageTokenUsage | undefined): StageTokenUsage {
  if (!b) return a;
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheCreation: a.cacheCreation + b.cacheCreation,
  };
}

function statusOf(state: PipelineState): string {
  if (state.completedAt) return 'completed';
  if (state.error) return `stopped at ${state.error.stage} (${state.error.type})`;
  if (state.checkpoint) return `waiting at ${state.checkpoint.name}`;
  return 'running';
}

function stageRows(s: StageTelemetry): CostRow[] {
  const rows: CostRow[] = [{
    name: s.name,
    subAgent: false,
    model: s.model,
    turns: s.turns,
    durationMs: s.durationMs,
    tokens: s.tokens,
    costUsd: s.costUsd,
    startedAt: s.startedAt ?? s.timestamp,
    subtype: s.subtype,
  }];
  for (const sub of Object.values(s.subAgents ?? {})) {
    rows.push({
      name: sub.name,
      subAgent: true,
      model: sub.model ?? '',
      turns: sub.turns,
      durationMs: 0,
      tokens: sub.tokens,
    });
  }
  return rows;
}

export function buildCostReport(workItemId: number, state: PipelineState): CostReport {
  const stages = state.telemetry?.stages ?? [];
  let tokens = ZERO;
  let turns = 0;
  for (const s of stages) {
    tokens = addTokens(tokens, s.tokens);
    turns += s.turns;
  }
  return {
    workItemId,
    status: statusOf(state),
    rows: stages.flatMap(stageRows),
    total: {
      costUsd: stages.reduce((sum, s) => sum + (s.costUsd ?? 0), 0),
      durationMs: stages.reduce((sum, s) => sum + (s.durationMs ?? 0), 0),
      turns,
      tokens,
      runs: stages.length,
    },
  };
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const fmtInt = (n: number | undefined) => (n == null ? '—' : n.toLocaleString('en-US'));
const fmtUsd = (n: number | undefined) => (n == null ? '' : `$${n.toFixed(2)}`);
const fmtMin = (ms: number) => (ms ? (ms / 60_000).toFixed(1) : '');
const shortModel = (m: string) => m.replace(/^claude-/, '');

const COLUMNS = ['Stage', 'Model', 'Turns', 'Min', 'Input', 'Output', 'Cache read', 'Cache write', 'USD'];

function cells(r: CostRow): string[] {
  return [
    r.subAgent ? `  └ ${r.name}` : r.name,
    shortModel(r.model),
    String(r.turns),
    fmtMin(r.durationMs),
    fmtInt(r.tokens?.input),
    fmtInt(r.tokens?.output),
    fmtInt(r.tokens?.cacheRead),
    fmtInt(r.tokens?.cacheCreation),
    fmtUsd(r.costUsd),
  ];
}

function totalCells(t: CostReport['total']): string[] {
  return [
    `TOTAL (${t.runs} run${t.runs === 1 ? '' : 's'})`, '', String(t.turns), fmtMin(t.durationMs),
    fmtInt(t.tokens.input), fmtInt(t.tokens.output), fmtInt(t.tokens.cacheRead), fmtInt(t.tokens.cacheCreation),
    fmtUsd(t.costUsd),
  ];
}

const NOTE = 'USD = API list price reported by the Claude Agent SDK; on a subscription token it is an equivalent, not a bill. '
  + 'Sub-agent tokens are part of their stage\'s total.';

export function formatCostReportText(r: CostReport): string {
  const body = [COLUMNS, ...r.rows.map(cells), totalCells(r.total)];
  const widths = COLUMNS.map((_, i) => Math.max(...body.map(row => row[i]!.length)));
  const line = (row: string[]) => row.map((c, i) => (i === 0 || i === 1 ? c.padEnd(widths[i]!) : c.padStart(widths[i]!))).join('  ');
  const sep = widths.map(w => '─'.repeat(w)).join('  ');
  return [
    `Cost report — work item #${r.workItemId} — ${r.status}`,
    '',
    line(COLUMNS),
    sep,
    ...r.rows.map(row => line(cells(row))),
    sep,
    line(totalCells(r.total)),
    '',
    NOTE,
  ].join('\n');
}

export function formatCostReportMarkdown(r: CostReport): string {
  const row = (c: string[]) => `| ${c.join(' | ')} |`;
  return [
    `### Cost report — work item #${r.workItemId} — ${r.status}`,
    '',
    row(COLUMNS),
    row(COLUMNS.map((_, i) => (i < 2 ? '---' : '---:'))),
    ...r.rows.map(x => row(cells(x))),
    row(totalCells(r.total).map(c => (c ? `**${c}**` : c))),
    '',
    `*${NOTE}*`,
  ].join('\n');
}

/** One line per work item, for comparing tickets. */
export function formatCostSummary(reports: CostReport[]): string {
  const head = ['Work item', 'Status', 'Runs', 'Turns', 'Min', 'Output tok', 'USD'];
  const rows = reports.map(r => [
    `#${r.workItemId}`, r.status, String(r.total.runs), String(r.total.turns), fmtMin(r.total.durationMs),
    fmtInt(r.total.tokens.output), fmtUsd(r.total.costUsd),
  ]);
  const all = [head, ...rows];
  const widths = head.map((_, i) => Math.max(...all.map(x => x[i]!.length)));
  return all.map(x => x.map((c, i) => (i < 2 ? c.padEnd(widths[i]!) : c.padStart(widths[i]!))).join('  ')).join('\n');
}
