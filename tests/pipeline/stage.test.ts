import { describe, test, expect } from 'bun:test';
import { z } from 'zod';
import type { PipelineState } from '../../src/types/pipeline.types.ts';
import { agentStage, resolveAgentModel, applyOutputKeepingTelemetry } from '../../src/pipeline/stage.ts';
import { PipelineError } from '../../src/sdk/errors.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function freshState(): PipelineState {
  return {
    currentStage: 'test',
    telemetry: { totalCostUsd: 0, totalDurationMs: 0, stages: [] },
    startedAt: new Date().toISOString(),
  };
}

const TestSchema = z.object({ value: z.string() });

function testAgentConfig(overrides?: { name?: string }) {
  return {
    name: overrides?.name ?? 'test-agent',
    sharedPromptFragments: [] as string[],
    outputSchema: TestSchema,
    allowedTools: [] as string[],
    buildPrompt: () => 'prompt',
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('agentStage', () => {
  test('creates a Stage with correct name', () => {
    const stage = agentStage({
      agent: testAgentConfig({ name: 'my-agent' }),
      canRun: () => true,
      applyOutput: (s, _out) => s,
    });

    expect(stage.name).toBe('my-agent');
  });

  test('canRun delegates to config.canRun', () => {
    const stage = agentStage({
      agent: testAgentConfig({ name: 'my-agent' }),
      canRun: (s) => s.devPlan != null,
      applyOutput: (s, _out) => s,
    });

    expect(stage.canRun(freshState())).toBe(false);
    expect(stage.canRun({ ...freshState(), devPlan: {} as any })).toBe(true);
  });
});

describe('resolveAgentModel', () => {
  test('uses agent-level model when set', () => {
    const result = resolveAgentModel(
      'claude-haiku-4-5',
      'coder',
      { default: 'claude-opus-4-6', perAgent: { coder: 'claude-sonnet-4-6' } },
    );
    expect(result).toBe('claude-haiku-4-5');
  });

  test('uses perAgent override when agent model is undefined', () => {
    const result = resolveAgentModel(
      undefined,
      'coder',
      { default: 'claude-opus-4-6', perAgent: { coder: 'claude-sonnet-4-6' } },
    );
    expect(result).toBe('claude-sonnet-4-6');
  });

  test('falls back to default when no agent model or perAgent override', () => {
    const result = resolveAgentModel(
      undefined,
      'coder',
      { default: 'claude-opus-4-6', perAgent: {} },
    );
    expect(result).toBe('claude-opus-4-6');
  });

  test('falls back to default when perAgent is undefined', () => {
    const result = resolveAgentModel(
      undefined,
      'coder',
      { default: 'claude-opus-4-6' },
    );
    expect(result).toBe('claude-opus-4-6');
  });

  test('matches correct agent name in perAgent map', () => {
    const result = resolveAgentModel(
      undefined,
      'planner',
      { default: 'claude-opus-4-6', perAgent: { coder: 'claude-sonnet-4-6', planner: 'claude-haiku-4-5' } },
    );
    expect(result).toBe('claude-haiku-4-5');
  });
});

describe('applyOutputKeepingTelemetry', () => {
  const telemetry = {
    totalCostUsd: 1.25,
    totalDurationMs: 60_000,
    stages: [{ name: 'analyzer', costUsd: 1.25, durationMs: 60_000, turns: 12, model: 'claude-opus-5-5', timestamp: 't' }],
  };

  test('success: the output is applied and the telemetry attached', () => {
    const s = applyOutputKeepingTelemetry((st, out: { v: string }) => ({ ...st, currentStage: out.v }), freshState(), { v: 'next' }, telemetry);
    expect(s.currentStage).toBe('next');
    expect(s.telemetry).toEqual(telemetry);
  });

  test('a PipelineError from applyOutput (analyzer needs-input) keeps the paid-for run', () => {
    // Work item 43: the analyzer ran, asked questions, and the saved state showed $0 and no stage.
    let caught: unknown;
    try {
      applyOutputKeepingTelemetry(() => { throw new PipelineError('needs-input', 'analyzer', 'q'); }, freshState(), {}, telemetry);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PipelineError);
    expect((caught as PipelineError).partialState?.telemetry).toEqual(telemetry);
  });

  test('an error that already carries state is left alone', () => {
    const own = { ...freshState(), currentStage: 'own' };
    const e = new PipelineError('x', 'analyzer', 'm');
    e.partialState = own;
    expect(() => applyOutputKeepingTelemetry(() => { throw e; }, freshState(), {}, telemetry)).toThrow(e);
    expect(e.partialState).toBe(own);
  });

  test('other errors are rethrown unchanged', () => {
    const e = new TypeError('boom');
    expect(() => applyOutputKeepingTelemetry(() => { throw e; }, freshState(), {}, telemetry)).toThrow(e);
  });
});