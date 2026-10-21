// ---------------------------------------------------------------------------
// Agent keyword — a human-friendly alias for the comment commands.
//
// People tag each other with @Name. The agent has no Azure DevOps account, so
// it cannot be picked from the mention list, but a comment line that starts
// with the plain text `@agent` (or `#agent`) followed by a verb is read as the
// matching slash command:
//
//   @agent continue …        → /continue      (resume after answering questions)
//   @agent approve …         → /approve       (approve the plan)
//   @agent change plan …     → /rerun-plan
//   @agent fix test …        → /fix-test
//   @agent fix …             → /fix
//
// Once the agent gets a real account, a real mention renders as
// `<a …>@Agent</a>`; after tag stripping it reads `@Agent …`, so the same
// parser keeps working. A line with `@agent` and no known verb is left as is —
// the agent reads it as ordinary discussion on its next run.
// ---------------------------------------------------------------------------

const KEYWORD = String.raw`[@#]agent\b[\s:,.\-–—]*`;

/** Verb patterns, most specific first (`fix test` before `fix`). */
const VERBS: Array<{ pattern: string; command: string }> = [
  { pattern: String.raw`fix[\s-]+tests?\b`, command: '/fix-test' },
  { pattern: String.raw`fix\b`, command: '/fix' },
  { pattern: String.raw`(?:(?:change|rerun|redo|revise)[\s-]+(?:the\s+)?plan|replan|rerun-plan)\b`, command: '/rerun-plan' },
  { pattern: String.raw`(?:approved?(?:\s+(?:the\s+)?plan)?|plan\s+(?:ok|approved))\b`, command: '/approve' },
  { pattern: String.raw`(?:continue|resume|go\s+on|go)\b`, command: '/continue' },
];

const LINE_PATTERNS = VERBS.map(({ pattern, command }) => ({
  regex: new RegExp(String.raw`^(\s*)${KEYWORD}${pattern}[\s:,.\-–—]*`, 'i'),
  command,
}));

/** Rewrite each `@agent <verb> …` line as `/<command> …`; other lines are unchanged. */
export function normalizeAgentKeywords(text: string): string {
  return text
    .split('\n')
    .map(line => {
      for (const { regex, command } of LINE_PATTERNS) {
        const m = regex.exec(line);
        if (m) {
          const rest = line.slice(m[0].length);
          return `${m[1]}${command}${rest ? ` ${rest}` : ''}`;
        }
      }
      return line;
    })
    .join('\n');
}

/**
 * HTML comment → plain text for command matching. Block ends and `<br>` become
 * line breaks so a command at the start of any paragraph is found, then
 * `@agent` keywords are rewritten to their slash commands.
 */
export function commentToCommandText(html: string): string {
  const plain = html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:div|p|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;|\u00a0/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();
  return normalizeAgentKeywords(plain);
}

/** True when `text` has `command` at the start of a line. */
export function hasCommand(text: string, command: string): boolean {
  const escaped = command.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  return new RegExp(`(?:^|\\n)\\s*${escaped}`, 'm').test(text);
}
