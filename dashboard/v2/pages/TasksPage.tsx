import { useMemo, useState } from 'react';
import { Input, Select, Space } from 'antd';
import { SearchOutlined } from '@ant-design/icons';
import type { Task } from '../../../src/dashboard/tasks.js';
import type { Snapshot } from '../useDashboard.js';
import { STATE_LABELS, searchText } from '../semantics.js';
import { projectOptions } from '../selectors.js';
import { TaskTable } from '../components/TaskTable.js';
import { LoadingBlock } from '../components/StateViews.js';
import { SourceNote } from '../components/SourceNote.js';

/** Task workbench: project / stage filters, search, list and the detail drawer. */
export function TasksPage({ snapshot, tasks, loading, onOpen }: {
  snapshot: Snapshot | null; tasks: Task[]; loading: boolean; onOpen: (task: Task) => void;
}) {
  const [project, setProject] = useState<string>('all');
  const [state, setState] = useState<string>('all');
  const [search, setSearch] = useState('');

  const options = useMemo(() => projectOptions(snapshot, tasks), [snapshot, tasks]);
  const stateOptions = useMemo(() => [...new Set(tasks.map(task => task.state))].sort(), [tasks]);
  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return tasks.filter(task =>
      (project === 'all' || task.project_id === project) &&
      (state === 'all' || task.state === state) &&
      (!needle || searchText(task).includes(needle)));
  }, [tasks, project, state, search]);

  return <Space direction="vertical" size={16} style={{ width: '100%' }}>
    <Space wrap size={[12, 12]} style={{ width: '100%' }}>
      <Select aria-label="按项目筛选" value={project} onChange={setProject} style={{ minWidth: 220 }}
        options={[{ value: 'all', label: '全部项目' }, ...options]} />
      <Select aria-label="按阶段筛选" value={state} onChange={setState} style={{ minWidth: 190 }}
        options={[{ value: 'all', label: '全部阶段' }, ...stateOptions.map(value => ({ value, label: STATE_LABELS[value] ?? value }))]} />
      <Input aria-label="搜索任务" allowClear prefix={<SearchOutlined />} placeholder="搜索任务、仓库、执行者、动作…"
        value={search} onChange={event => setSearch(event.target.value)} style={{ minWidth: 240, maxWidth: 360 }} />
    </Space>
    {loading
      ? <LoadingBlock title="正在加载任务…" rows={6} />
      : <TaskTable tasks={filtered} loading={false} onOpen={onOpen} />}
    <SourceNote extra={`筛选后 ${filtered.length} / ${tasks.length} 条`} />
  </Space>;
}
