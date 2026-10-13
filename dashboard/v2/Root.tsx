import { useState } from 'react';
import { App as AntApp, ConfigProvider, Tag } from 'antd';
import zhCN from 'antd/es/locale/zh_CN';
import { awhTheme } from './theme.js';
import { AppShell, type V2View } from './components/AppShell.js';
import { ConnectionBar } from './components/ConnectionBar.js';
import { PhaseAlert } from './components/StateViews.js';
import { TaskDetailDrawer } from './components/TaskDetailDrawer.js';
import { OverviewPage } from './pages/OverviewPage.js';
import { TasksPage } from './pages/TasksPage.js';
import { isFixtureDataset, useDashboard } from './useDashboard.js';
import { presentTasks, presentDetail } from './presentation.js';
import { PHASE_META } from './semantics.js';

/** Composition root: navigation, data hook and the two pages. No page logic lives here. */
export function App() {
  const { state, now, refresh, detail, openTask, closeTask } = useDashboard();
  const [view, setView] = useState<V2View>('Overview');
  const fixture = isFixtureDataset();
  const tasks = presentTasks(state, now);
  const displayedDetail = presentDetail(detail, state, now);
  const openPresentedTask = (task: typeof tasks[number]) => {
    const raw = state.snapshot?.tasks?.find(item => item.id === task.id);
    if (raw) openTask(raw);
  };
  const meta = PHASE_META[state.phase] ?? PHASE_META.error;

  return <ConfigProvider locale={zhCN} theme={awhTheme}>
    <AntApp>
      <AppShell view={view} onSelect={setView} extra={<Tag color={meta.color} style={{ marginInlineEnd: 0 }}>{meta.label}</Tag>}>
        <ConnectionBar phase={state.phase} lastRefresh={state.lastRefresh} cursor={state.snapshot?.cursor ?? null}
          tasks={tasks} fixture={fixture} refreshing={state.phase === 'refreshing'} onRefresh={refresh} />
        <PhaseAlert phase={state.phase} error={state.error} hasSnapshot={state.snapshot !== null} />
        {view === 'Overview'
          ? <OverviewPage snapshot={state.snapshot} tasks={tasks} loading={state.phase === 'loading'} onOpen={openPresentedTask} />
          : <TasksPage snapshot={state.snapshot} tasks={tasks} loading={state.phase === 'loading'} onOpen={openPresentedTask} />}
      </AppShell>
      <TaskDetailDrawer detail={displayedDetail} open={detail.item !== null} onClose={closeTask} />
    </AntApp>
  </ConfigProvider>;
}
