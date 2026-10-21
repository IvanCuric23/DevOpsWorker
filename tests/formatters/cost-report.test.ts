import { describe, test, expect } from 'bun:test';
import type { PipelineState } from '../../src/types/pipeline.types.ts';
import {
  buildCostReport,
  formatCostReportMarkdown,
  formatCostReportText,
  formatCostSummary,
} from '../../src/formatters/cost-report.ts';

function state(overrides: Partial<PipelineState> = {}): PipelineState {
  return {
    currentStage: 'x',
    startedAt: 't',
    telemetry: {
      totalCostUsd: 3.5,
      totalDurationMs: 600_000,
      stages: [
        {
          name: 'analyzer', costUsd: 1.25, durationMs: 180_000, turns: 20, model: 'claude-opus-5-5', timestamp: 't1',
          tokens: { input: 1_000, output: 4_000, cacheRead: 200_000, cacheCreation: 30_000 },
        },
        {
          name: 'plan-reviewer', costUsd: 2.25, durationMs: 420_000, turns: 30, model: 'claude-opus-5-5', timestamp: 't2',
          tokens: { input: 2_000, output: 6_000, cacheRead: 300_000, cacheCreation: 40_000 },
          subAgents: {
            'feasibility-reviewer': {
              name: 'feasibility-reviewer', turns: 9, model: 'claude-sonnet-5-5', toolCalls: {},
              tokens: { input: 100, output: 900, cacheRead: 50_000, cacheCreation: 5_000 },
            } as never,
          },
        },
      ],
    },
    ...overrides,
  };
}

describe('buildCostReport', () => {
  test('one row per stage run, sub-agents under their stage', () => {
    const r = buildCostReport(45, state());
    expect(r.rows.map(x => [x.name, x.subAgent])).toEqual([
      ['analyzer', false], ['plan-reviewer', false], ['feasibility-reviewer', true],
    ]);
    expect(r.rows[2]!.costUsd).toBeUndefined();
  });

  test('totals add the stages only — sub-agent tokens are already inside their stage', () => {
    const r = buildCostReport(45, state());
    expect(r.total).toEqual({
      costUsd: 3.5, durationMs: 600_000, turns: 50, runs: 2,
      tokens: { input: 3_000, output: 10_000, cacheRead: 500_000, cacheCreation: 70_000 },
    });
  });

  test('status says where the ticket is', () => {
    expect(buildCostReport(1, state({ checkpoint: { name: 'plan-approved', enteredAt: 't' } })).status).toBe('waiting at plan-approved');
    expect(buildCostReport(1, state({ error: { type: 'needs-input', stage: 'analyzer', message: 'm', timestamp: 't' } })).status)
      .toBe('stopped at analyzer (needs-input)');
    expect(buildCostReport(1, state({ completedAt: 't' })).status).toBe('completed');
  });

  test('older entries without token data show a dash, not zero', () => {
    const s = state();
    delete s.telemetry.stages[0]!.tokens;
    expect(formatCostReportText(buildCostReport(45, s))).toContain('—');
  });

  test('an empty run reports zero, without crashing', () => {
    const r = buildCostReport(43, state({ telemetry: { totalCostUsd: 0, totalDurationMs: 0, stages: [] } }));
    expect(r.total.runs).toBe(0);
    expect(formatCostReportText(r)).toContain('TOTAL (0 runs)');
  });
});

describe('formatting', () => {
  test('text report has the columns, the total and the subscription note', () => {
    const t = formatCostReportText(buildCostReport(45, state()));
    expect(t).toContain('Cost report — work item #45');
    expect(t).toContain('Cache read');
    expect(t).toContain('└ feasibility-reviewer');
    expect(t).toContain('TOTAL (2 runs)');
    expect(t).toContain('$3.50');
    expect(t).toContain('not a bill');
  });

  test('markdown report is a table', () => {
    const m = formatCostReportMarkdown(buildCostReport(45, state()));
    expect(m).toContain('| Stage | Model |');
    expect(m).toContain('| analyzer | opus-5-5 | 20 | 3.0 |');
  });

  test('summary has one line per ticket', () => {
    const s = formatCostSummary([buildCostReport(43, state()), buildCostReport(45, state())]);
    expect(s.split('\n')).toHaveLength(3);
    expect(s).toContain('#45');
  });
});
