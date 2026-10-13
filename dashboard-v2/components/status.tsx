import { Badge } from './ui/badge';
import { phaseLabels, taskLabels } from '../lib/task-model.mjs';
export function Status({value}:{value:string}) {
  const tone = ['live','completed'].includes(value)?'good':['error','outdated','offline','blocked','unknown','changes_requested'].includes(value)?'warn':'neutral';
  return <Badge variant="outline" className={`status status-${tone}`}><span className="status-dot" aria-hidden="true"/>{(taskLabels as Record<string,string>)[value]??(phaseLabels as Record<string,string>)[value]??value}</Badge>;
}
