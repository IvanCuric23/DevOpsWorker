import { describe, test, expect } from 'bun:test';
import { normalizeAgentKeywords, commentToCommandText, hasCommand } from '../../../src/sdk/ado/agent-keyword.ts';

describe('normalizeAgentKeywords', () => {
  test.each([
    ['@agent continue', '/continue'],
    ['@Agent continue — answers above', '/continue answers above'],
    ['#agent resume', '/continue'],
    ['@agent go on', '/continue'],
    ['@agent approve', '/approve'],
    ['@agent approve the plan', '/approve'],
    ['@agent plan ok', '/approve'],
    ['@agent fix the Location filter', '/fix the Location filter'],
    ['@agent: fix test', '/fix-test'],
    ['@agent fix tests on posting', '/fix-test on posting'],
    ['@agent change plan use Inventory Setup', '/rerun-plan use Inventory Setup'],
    ['@agent change the plan: no new table', '/rerun-plan no new table'],
    ['@agent replan', '/rerun-plan'],
  ])('%p → %p', (input, expected) => {
    expect(normalizeAgentKeywords(input)).toBe(expected);
  });

  test('leaves @agent with an unknown verb as ordinary text', () => {
    expect(normalizeAgentKeywords('@agent what do you think?')).toBe('@agent what do you think?');
  });

  test('does not touch mentions of people or words that start with "agent"', () => {
    expect(normalizeAgentKeywords('@Ana please check')).toBe('@Ana please check');
    expect(normalizeAgentKeywords('@agentur continue')).toBe('@agentur continue');
  });

  test('only rewrites a keyword at the start of a line', () => {
    expect(normalizeAgentKeywords('please @agent fix it')).toBe('please @agent fix it');
    expect(normalizeAgentKeywords('Answers:\n1. yes\n@agent continue')).toBe('Answers:\n1. yes\n/continue');
  });

  test('does not read "go" inside a longer word as a verb', () => {
    expect(normalizeAgentKeywords('@agent good job')).toBe('@agent good job');
  });
});

describe('commentToCommandText', () => {
  test('a keyword in a later paragraph of an HTML comment is found', () => {
    const html = '<div>1. Yes</div><div>2. Per item and location</div><div>@agent continue</div>';
    expect(hasCommand(commentToCommandText(html), '/continue')).toBe(true);
  });

  test('a real mention of an Agent account reads the same as the typed keyword', () => {
    const html = '<div><a href="#" data-vss-mention="version:2.0,abc">@Agent</a>&nbsp;fix the filter</div>';
    expect(commentToCommandText(html)).toBe('/fix the filter');
  });

  test('plain slash commands still work', () => {
    expect(hasCommand(commentToCommandText('<p>/rerun-plan no new table</p>'), '/rerun-plan')).toBe(true);
  });

  test('a comment without a command matches nothing', () => {
    const text = commentToCommandText('<div>@Ana can you ask the client about question 2?</div>');
    for (const cmd of ['/continue', '/approve', '/fix', '/rerun-plan']) expect(hasCommand(text, cmd)).toBe(false);
  });
});
