export interface ReviewerIdentity { readonly login: string; readonly id: number }
/** Shared Strict Builder identity predicate. Editable observations never provide this allowlist. */
export function authorizedReviewer(user: {type?:string;login?:string;id?:number}|undefined, reviewers: readonly ReviewerIdentity[], author: string) {
  return user?.type==='User' && user.login!==author && reviewers.some(a=>a.login===user.login&&a.id===user.id);
}
export function strictReviewDecision(reviews:Record<string,any>[],reviewers:readonly ReviewerIdentity[],author:string,head:string) {
  const latest=new Map<string,Record<string,any>>();
  for(const review of [...reviews].sort((a,b)=>a.id-b.id)) {
    if(authorizedReviewer(review.user,reviewers,author)&&!['COMMENTED','PENDING'].includes(review.state))latest.set(review.user.login,review);
  }
  // Strict lifecycle blocks on an outstanding authorized changes request, even from an older HEAD.
  const decisions=[...latest.values()];
  const changes=decisions.find(r=>r.state==='CHANGES_REQUESTED');
  const selected=changes??decisions.find(r=>r.state==='APPROVED'&&r.commit_id===head);
  return selected ? {review:selected,decision:changes?'REQUEST_CHANGES' as const:'PASS' as const} : null;
}
