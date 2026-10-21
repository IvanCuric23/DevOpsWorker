import { describe, test, expect } from 'bun:test';
import {
  reviewEventsForPr,
  pollGate,
  pollMinutesFromEnv,
  type PolledPullRequest,
  type PolledThread,
} from '../../../src/cli/watch/pr-review-poller.ts';
import { dedupScopeFor } from '../../../src/webhook-server/index.ts';
import type { RepoConfig } from '../../../src/config/repo-config.ts';

const SINCE = '2026-10-21T10:00:00.000Z';

function pr(overrides: Partial<PolledPullRequest> = {}): PolledPullRequest {
  return {
    pullRequestId: 7,
    status: 'active',
    isDraft: false,
    creationDate: '2026-10-21T11:00:00.000Z',
    sourceRefName: 'refs/heads/feature/45-margin',
    targetRefName: 'refs/heads/master',
    title: 'Margin reposting',
    createdBy: { displayName: 'Dev' },
    repository: { id: 'repo-guid', name: 'HocuKnjigu', project: { name: 'HocuKnjigu' } },
    ...overrides,
  };
}

const comment = (id: number, content: string, publishedDate = '2026-10-21T12:00:00.000Z', extra = {}) =>
  ({ id, content, publishedDate, commentType: 'text', ...extra });

const REPO: { key: string; config: RepoConfig } = {
  key: 'HocuKnjigu',
  config: {
    url: 'u', branch: 'master',
    azureDevOps: { project: 'HocuKnjigu', repositoryId: 'repo-guid', repositoryName: 'HocuKnjigu', areaPath: 'a' },
  } as unknown as RepoConfig,
};

describe('reviewEventsForPr', () => {
  test('a published PR created after the cutoff gets one event with the review-once dedup rule', () => {
    const [e, ...rest] = reviewEventsForPr(pr(), [], SINCE, 'HocuKnjigu');
    expect(rest).toEqual([]);
    expect(e!.publishedFromDraft).toBe(true);
    expect(e!.pr.id).toBe(7);
    // All-time per-PR dedup: polling sees the PR again every few minutes.
    expect(dedupScopeFor(e!)).toEqual({ key: 'prId', value: '7', pendingOnly: false });
  });

  test('PRs older than the cutoff, drafts and closed PRs are not auto-reviewed', () => {
    expect(reviewEventsForPr(pr({ creationDate: '2026-10-20T00:00:00.000Z' }), [], SINCE, 'p')).toEqual([]);
    expect(reviewEventsForPr(pr({ isDraft: true }), [], SINCE, 'p')).toEqual([]);
    expect(reviewEventsForPr(pr({ status: 'completed' }), [], SINCE, 'p')).toEqual([]);
  });

  test('/review and /review-full comments after the cutoff each give a comment-keyed event', () => {
    const threads: PolledThread[] = [
      { id: 11, comments: [comment(1, '<p>/review</p>'), comment(2, 'looks fine')] },
      { id: 12, comments: [comment(1, '/review-full')] },
    ];
    const events = reviewEventsForPr(pr({ creationDate: '2026-10-01T00:00:00.000Z' }), threads, SINCE, 'p');
    expect(events.map(e => [e.commentKey, e.forceFull ?? false])).toEqual([['11:1', false], ['12:1', true]]);
    expect(dedupScopeFor(events[0]!).key).toBe('commentKey');
  });

  test('@agent review and @agent review full work like the slash commands', () => {
    const threads: PolledThread[] = [
      { id: 21, comments: [comment(1, '<div>Fixed the filter.</div><div>@agent review</div>')] },
      { id: 22, comments: [comment(1, '@Agent review full')] },
    ];
    const events = reviewEventsForPr(pr({ isDraft: true }), threads, SINCE, 'p');
    expect(events.map(e => [e.commentKey, e.forceFull ?? false])).toEqual([['21:1', false], ['22:1', true]]);
  });

  test('old, deleted, system and mid-sentence /review comments are ignored', () => {
    const threads: PolledThread[] = [{
      id: 11,
      comments: [
        comment(1, '/review', '2026-10-21T09:00:00.000Z'),
        comment(2, '/review', undefined, { isDeleted: true }),
        comment(3, '/review', undefined, { commentType: 'system' }),
        comment(4, 'please /review this'),
        comment(5, '/reviewfull'),
      ],
    }];
    expect(reviewEventsForPr(pr({ isDraft: true }), threads, SINCE, 'p')).toEqual([]);
  });
});

describe('pollGate — the webhook server\'s gates', () => {
  const auto = reviewEventsForPr(pr(), [], SINCE, 'p')[0]!;
  const byComment = reviewEventsForPr(pr({ isDraft: true }), [{ id: 1, comments: [comment(1, '/review')] }], SINCE, 'p')[0]!;

  test('a normal PR in a registered repo passes', () => {
    expect(pollGate(auto, REPO, false, undefined)).toBeNull();
  });

  test('unknown repo, passive repo, skipped branch and pipeline PR stop the automatic review', () => {
    expect(pollGate(auto, undefined, false, undefined)).toBe('unknown repo');
    expect(pollGate(auto, { ...REPO, config: { ...REPO.config, autoReview: false } }, false, undefined)).toBe('auto-review disabled');
    expect(pollGate(auto, REPO, false, 'feature/')).toBe('skipped branch');
    expect(pollGate(auto, REPO, true, undefined)).toBe('pipeline PR');
  });

  test('an explicit /review comment is honoured even on a draft, passive repo or pipeline PR', () => {
    expect(pollGate(byComment, { ...REPO, config: { ...REPO.config, autoReview: false } }, true, 'feature/')).toBeNull();
  });
});

describe('pollMinutesFromEnv', () => {
  test('off unless a positive number', () => {
    expect(pollMinutesFromEnv({})).toBe(0);
    expect(pollMinutesFromEnv({ PR_REVIEW_POLL_MINUTES: '0' })).toBe(0);
    expect(pollMinutesFromEnv({ PR_REVIEW_POLL_MINUTES: 'abc' })).toBe(0);
    expect(pollMinutesFromEnv({ PR_REVIEW_POLL_MINUTES: '5' })).toBe(5);
  });
});
