import { describe, test, expect } from 'bun:test';
import { formatNeedsInputComment, pipelineErrorComment, isPipelineComment } from '../../src/formatters/devops-comment.ts';
import { commentToCommandText, hasCommand } from '../../src/sdk/ado/agent-keyword.ts';

const MESSAGE = [
  'Analyzer needs human input before proceeding:',
  '',
  '- **Scope**: [client, via the consultant] Is ZGNAVSHOCU-478 still wanted? — default: do not build until confirmed',
  '- **Grouping**: [client, via the consultant] One row per item, or per item and location?',
  '  — default: per item and location',
  '- **Fix scope**: [developer] Also fix positive-adjustment false positives?',
].join('\n');

describe('formatNeedsInputComment', () => {
  test('numbers every question and keeps continuation lines with their question', () => {
    const c = formatNeedsInputComment(43, MESSAGE)!;
    expect(c).toContain('The agent has questions');
    expect(c).toContain('1. **Scope**: [client, via the consultant] Is ZGNAVSHOCU-478 still wanted?');
    expect(c).toContain('2. **Grouping**: [client, via the consultant] One row per item, or per item and location? — default: per item and location');
    expect(c).toContain('3. **Fix scope**: [developer]');
    expect(c).not.toContain('Pipeline Error');
  });

  test('tells people how to answer and how to resume', () => {
    const c = formatNeedsInputComment(43, MESSAGE)!;
    expect(c).toContain('@agent continue');
    expect(c).toContain('tag `continue`');
  });

  test('is recognised as pipeline output, so its own "@agent continue" never resumes the run', () => {
    const c = formatNeedsInputComment(43, MESSAGE)!;
    expect(isPipelineComment(c)).toBe(true);
    // Sanity: the instruction text alone would not be a command either — it is mid-line.
    expect(hasCommand(commentToCommandText(c), '/continue')).toBe(false);
  });

  test('returns null for any other message', () => {
    expect(formatNeedsInputComment(43, 'Container crashed')).toBeNull();
    expect(formatNeedsInputComment(43, 'Analyzer flagged needs-input but no specific gaps were listed.')).toBeNull();
  });
});

describe('pipelineErrorComment — analyzer questions', () => {
  test('posts the questions comment as Markdown for the analyzer stage', () => {
    const r = pipelineErrorComment(43, 'analyzer', new Error(MESSAGE));
    expect(r.format).toBe('markdown');
    expect(r.text).toContain('The agent has questions');
  });

  test('keeps the error comment for other analyzer failures', () => {
    const r = pipelineErrorComment(43, 'analyzer', new Error('Agent "analyzer" failed to produce a result'));
    expect(r.format).toBe('html');
    expect(r.text).toContain('Pipeline Error');
  });
});
