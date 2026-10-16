import type {
  CheckResult,
  GitHubClient,
  ProtectionRules,
  PullRequest,
  Review,
} from './github/client.js';

/** What the base branch's rules require before a pull request may merge. */
export interface Requirements {
  /** False when GitHub would not show the app the rules (403): then nothing merges automatically. */
  known: boolean;
  /** Where the rules came from, e.g. `branch protection`, `rulesets`. */
  sources: string[];
  requiredApprovals: number;
  codeOwnerReview: boolean;
  requiredChecks: string[];
  notes: string[];
}

/** Reads classic branch protection and rulesets for the base branch. 404 means "no rules". */
export async function readRequirements(gh: GitHubClient, base: string): Promise<Requirements> {
  const [protection, rulesets] = await Promise.all([
    gh.branchProtection(base),
    gh.branchRulesets(base),
  ]);
  const req: Requirements = {
    known: true,
    sources: [],
    requiredApprovals: 0,
    codeOwnerReview: false,
    requiredChecks: [],
    notes: [],
  };
  const add = (source: string, rules: ProtectionRules) => {
    req.sources.push(source);
    req.requiredApprovals = Math.max(req.requiredApprovals, rules.requiredApprovals);
    req.codeOwnerReview ||= rules.codeOwnerReview;
    for (const c of rules.requiredChecks)
      if (!req.requiredChecks.includes(c)) req.requiredChecks.push(c);
  };
  for (const [source, lookup] of [
    ['branch protection', protection],
    ['rulesets', rulesets],
  ] as const) {
    if (lookup.status === 'ok') {
      const r = lookup.rules;
      if (r.requiredApprovals || r.codeOwnerReview || r.requiredChecks.length) add(source, r);
    } else if (lookup.status === 'forbidden') {
      req.known = false;
      req.notes.push(
        `GitHub does not let the editor read the ${source} of ${base}, so publishing waits for a maintainer to merge.`,
      );
    }
  }
  return req;
}

export interface ReviewState {
  requirements: Requirements;
  approvedBy: string[];
  changesRequestedBy: string[];
  checks: CheckResult[];
  /** Why the pull request cannot merge yet, in plain words. Empty when it can. */
  blockers: string[];
  canMerge: boolean;
}

/** Combines rules, reviews and checks into what still blocks the merge. */
export function evaluateReview(
  requirements: Requirements,
  pull: PullRequest | null,
  reviews: Review[],
  checks: CheckResult[],
): ReviewState {
  // The latest decisive review per reviewer counts, as on GitHub.
  const latest = new Map<string, Review['state']>();
  for (const r of reviews) {
    if (r.state === 'APPROVED' || r.state === 'CHANGES_REQUESTED' || r.state === 'DISMISSED')
      latest.set(r.user, r.state);
  }
  const approvedBy = [...latest].filter(([, s]) => s === 'APPROVED').map(([u]) => u);
  const changesRequestedBy = [...latest]
    .filter(([, s]) => s === 'CHANGES_REQUESTED')
    .map(([u]) => u);
  const blockers: string[] = [];
  if (!requirements.known) blockers.push('The branch rules could not be read.');
  if (changesRequestedBy.length)
    blockers.push(`Changes requested by ${changesRequestedBy.join(', ')}.`);
  if (approvedBy.length < requirements.requiredApprovals) {
    const n = requirements.requiredApprovals;
    blockers.push(`Needs ${n} approving review${n === 1 ? '' : 's'} (has ${approvedBy.length}).`);
  }
  if (requirements.codeOwnerReview && approvedBy.length === 0)
    blockers.push('Needs an approving review from a code owner.');
  for (const context of requirements.requiredChecks) {
    const state = checks.find((c) => c.context === context)?.state;
    if (state === 'failure') blockers.push(`Required check "${context}" failed.`);
    else if (state !== 'success') blockers.push(`Required check "${context}" has not passed yet.`);
  }
  if (pull?.mergeable === false)
    blockers.push('The pull request has conflicts with the base branch.');
  return {
    requirements,
    approvedBy,
    changesRequestedBy,
    checks,
    blockers,
    canMerge: blockers.length === 0,
  };
}
