import type { SourceTextIssue, SourceTextIssueList } from './intake-source-text.ts';

/** Page-wide coverage/structure caveats describe unverified scope, not detected bad text. */
export function sourceIssueCategory(
  issue: SourceTextIssue,
): SourceTextIssueList['issues'][number]['category'] {
  if (issue.kind === 'unreadable' || issue.kind === 'unsupported') return 'processing-failure';
  if (!issue.region.box && (issue.kind === 'coverage' || issue.kind === 'structure'))
    return 'not-inspected';
  return 'detected';
}
export function sourceIssueNeedsReview(issue: SourceTextIssue): boolean {
  return ['open', 'later', 'unreadable'].includes(issue.status);
}
