// Explicit, reproducible shadcn official registry import; no project-wide CLI init.
import { mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
mkdirSync('dashboard-v2/components/ui', { recursive: true });
const sources = [];
for (const name of ['button', 'badge', 'card', 'input', 'table', 'sheet']) {
  const url = `https://ui.shadcn.com/r/styles/new-york-v4/${name}.json`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Registry ${name}: ${response.status}`);
  const raw = await response.text(), item = JSON.parse(raw);
  for (const file of item.files) {
    if (file.type !== 'registry:ui') continue;
    const content = file.content.replaceAll('@/lib/utils', '../../lib/utils').replaceAll('from "cn"', 'from "../../lib/utils"').replace('>Close</span>', '>关闭任务详情</span>');
    writeFileSync(`dashboard-v2/components/ui/${name}.tsx`, content);
  }
  sources.push({ name, url, sha256: createHash('sha256').update(raw).digest('hex'), adjustments: ['Relative cn import for standalone esbuild; Sheet close label localized; component behavior unchanged.'] });
}
writeFileSync('dashboard-v2/registry-sources.json', JSON.stringify(sources, null, 2) + '\n');
