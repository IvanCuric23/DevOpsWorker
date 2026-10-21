// ---------------------------------------------------------------------------
// PR review poller — the webhook-free way to start DevOpsWorker's PR reviewer.
//
// The reviewer is normally started by Azure DevOps service hooks (PR created,
// draft published, `/review` comment) posted to the webhook server. A watcher
// that Azure DevOps cannot reach — a laptop, a server behind a firewall — never
// gets those hooks. This poller asks Azure DevOps instead: every few minutes it
// lists the active PRs of each registered repo and their comment threads, turns
// what it finds into the same events the webhook server parses, and queues
// `review-pr` actions with the same gates and the same dedup. The watcher's
// action queue then runs the reviews exactly as it does for webhooks.
//
// Enabled by PR_REVIEW_POLL_MINUTES (> 0). Only PRs created, and `/review`
// comments posted, after PR_REVIEW_POLL_SINCE (ISO date; default: watcher start)
// count — so switching it on does not review every PR already open.
// ---------------------------------------------------------------------------

import type { PipelineConfig } from '../../types/pipeline.types.ts';
import type { IStateStore } from '../../pipeline/state-store.interface.ts';
import type { IWebhookEventStore } from '../../pipeline/webhook-event-store.interface.ts';
import type { RepoConfig, RepoRegistry } from '../../config/repo-config.ts';
import { adoFetch } from '../../sdk/ado/http.ts';
import { skippedBranchPrefix, type PRWebhookEvent } from '../../webhook-server/parse.ts';
import { buildReviewPrActionFeedback, dedupScopeFor } from '../../webhook-server/index.ts';

export interface PolledPullRequest {
  pullRequestId: number;
  status: string;
  isDraft?: boolean;
  creationDate: string;
  sourceRefName: string;
  targetRefName: string;
  title?: string;
  description?: string;
  url?: string;
  createdBy?: { displayName?: string };
  repository: { id: string; name: string; project?: { name?: string } };
}

export interface PolledThread {
  id: number;
  comments: Array<{
    id: number;
    content?: string;
    commentType?: string;
    isDeleted?: boolean;
    publishedDate: string;
  }>;
}

// `/review`, `/review-full`, or the same as `@agent review` / `@agent review full` (see src/sdk/ado/agent-keyword.ts).
const REVIEW = /^\s*(?:\/review|[@#]agent\b[\s:,.\-–—]*review)\s*$/im;
const REVIEW_FULL = /^\s*(?:\/review-full|[@#]agent\b[\s:,.\-–—]*review[\s-]+full)\s*$/im;

function prOf(pr: PolledPullRequest, project: string): PRWebhookEvent['pr'] {
  return {
    id: pr.pullRequestId,
    repositoryId: pr.repository.id,
    repositoryName: pr.repository.name,
    project: pr.repository.project?.name ?? project,
    sourceBranch: pr.sourceRefName,
    targetBranch: pr.targetRefName,
    author: pr.createdBy?.displayName ?? '',
    status: pr.status,
    isDraft: pr.isDraft,
    url: pr.url,
    title: pr.title,
    description: pr.description,
  };
}

/**
 * Pure: the review events one poll yields for one PR.
 *
 * - A published (non-draft) PR created after `since` → one event with the
 *   draft-published dedup rule: one automatic review per PR, ever. Polling sees
 *   the same PR every few minutes, so the creation rule (dedup only against a
 *   pending review) would review it again after every finished review.
 * - Every `/review` or `/review-full` comment posted after `since` → one event
 *   keyed by the comment, like the webhook's comment event.
 */
export function reviewEventsForPr(
  pr: PolledPullRequest,
  threads: PolledThread[],
  since: string,
  project: string,
): PRWebhookEvent[] {
  const events: PRWebhookEvent[] = [];
  const base = prOf(pr, project);
  if (pr.status === 'active' && !pr.isDraft && pr.creationDate > since) {
    events.push({ eventType: 'poll.pullrequest', publishedFromDraft: true, pr: base });
  }
  for (const thread of threads) {
    for (const c of thread.comments) {
      if (c.isDeleted || !c.content || (c.commentType != null && c.commentType !== 'text')) continue;
      if (c.publishedDate <= since) continue;
      const text = c.content
        .replace(/<br\s*\/?>|<\/(?:div|p|li)>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;|\u00a0/g, ' ')
        .trim();
      const full = REVIEW_FULL.test(text);
      if (!full && !REVIEW.test(text)) continue;
      events.push({
        eventType: 'poll.pullrequest-comment',
        pr: base,
        commentKey: `${thread.id}:${c.id}`,
        ...(full ? { forceFull: true } : {}),
      });
    }
  }
  return events;
}

/**
 * Pure: why an event must not be queued, or null when it may be. The same gates,
 * in the same order, as the webhook server's handler (src/webhook-server/index.ts)
 * — keep the two in step.
 */
export function pollGate(
  event: PRWebhookEvent,
  repo: { key: string; config: RepoConfig } | undefined,
  isPipelinePr: boolean,
  skipBranches: string | undefined,
): string | null {
  if (!repo) return 'unknown repo';
  if (event.commentKey) return null;
  if (repo.config.autoReview === false) return 'auto-review disabled';
  if (event.pr.isDraft && repo.config.reviewDrafts !== true) return 'draft PR';
  if (skippedBranchPrefix(event.pr.sourceBranch, skipBranches)) return 'skipped branch';
  if (isPipelinePr) return 'pipeline PR';
  return null;
}

export interface PollDeps {
  stateStore: IStateStore;
  webhookEventStore: IWebhookEventStore;
  repos: RepoRegistry;
  log: (message: string) => void;
}

async function pipelinePrIds(stateStore: IStateStore): Promise<Set<number>> {
  const ids = new Set<number>();
  for (const id of await stateStore.listAll()) {
    const prId = (await stateStore.load(id))?.draftPR?.id;
    if (prId) ids.add(prId);
  }
  return ids;
}

/** One poll: list active PRs per registered repo, queue the reviews they ask for. Returns how many were queued. */
export async function pollPullRequestsForReview(
  config: PipelineConfig,
  deps: PollDeps,
  since: string,
): Promise<number> {
  const pipelinePrs = await pipelinePrIds(deps.stateStore);
  let queued = 0;
  for (const [key, repoConfig] of Object.entries(deps.repos)) {
    const repositoryId = repoConfig.azureDevOps?.repositoryId;
    if (!repositoryId) continue;
    const list = await adoFetch<{ value: PolledPullRequest[] }>(
      config.azureDevOps,
      `git/repositories/${repositoryId}/pullrequests?searchCriteria.status=active&$top=200&api-version=7.0`,
    );
    for (const pr of list.value) {
      const threads = await adoFetch<{ value: PolledThread[] }>(
        config.azureDevOps,
        `git/repositories/${repositoryId}/pullRequests/${pr.pullRequestId}/threads?api-version=7.0`,
      );
      for (const event of reviewEventsForPr(pr, threads.value, since, config.azureDevOps.project)) {
        const reason = pollGate(event, { key, config: repoConfig }, pipelinePrs.has(pr.pullRequestId), process.env['PR_REVIEW_SKIP_BRANCHES']);
        if (reason) continue;
        const scope = dedupScopeFor(event);
        const id = await deps.webhookEventStore.queueUnlessMatching(
          {
            workItemId: 0,
            type: 'review-pr',
            feedback: buildReviewPrActionFeedback(event, key),
            createdAt: new Date().toISOString(),
          },
          scope.key, scope.value, scope.pendingOnly,
        );
        if (id !== null) {
          queued++;
          deps.log(`PR poll: queued review for PR #${pr.pullRequestId} in ${pr.repository.name} (trigger: ${
            event.commentKey ? `/review comment ${event.commentKey}` : 'published PR'})`);
        }
      }
    }
  }
  return queued;
}

/** PR_REVIEW_POLL_MINUTES as a positive number of minutes, or 0 when off/invalid. */
export function pollMinutesFromEnv(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env['PR_REVIEW_POLL_MINUTES'] ?? '');
  return Number.isFinite(n) && n > 0 ? n : 0;
}
