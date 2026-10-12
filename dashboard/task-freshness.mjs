export function localStale(task,now=Date.now()) {
  return task.observations.some(o=>o.source!=='github'&&o.status==='verified'&&(!o.observed_at||now-Date.parse(o.observed_at)>45000||Date.parse(o.observed_at)>now));
}
export function githubStale(task,now=Date.now()) {
  const o=task.observations.find(o=>o.source==='github');
  const historical=task.pr?.merged_at&&task.issue.state==='closed';
  const ttl=historical?3600000:(task.github_refresh.interval_seconds||300)*1000+15000;
  return !o||o.status!=='verified'||o.freshness!=='fresh'||!o.observed_at||now-Date.parse(o.observed_at)>ttl||Date.parse(o.observed_at)>now;
}
export function taskStale(task,now=Date.now()) {
  return task.active_actor ? localStale(task,now) : !!task.github_head&&githubStale(task,now);
}
