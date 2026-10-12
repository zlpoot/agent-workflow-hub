import { loadTrustedPolicy } from '../profiles.js';
import { strictReviewDecision } from '../shared/review-gate.js';

/** Only the existing administrator-owned policy and independent digest supply standard Gate authority. */
export function standardReviewGate(repository:string,reviews:Record<string,any>[],author:string,head:string) {
  try {
    const policy=loadTrustedPolicy();
    if(!policy.profiles.some(p=>p.repository===repository)||!policy.installation.selected_repository_sets.some(s=>s.includes(repository)))return null;
    return {source:'administrator_policy' as const,selected:strictReviewDecision(reviews,policy.installation.reviewers,author,head)};
  } catch {return null;}
}
