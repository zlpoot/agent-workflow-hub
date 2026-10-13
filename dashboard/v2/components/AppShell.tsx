import { useState } from 'react';
import { Button, Drawer, Grid, Layout, Menu, Typography } from 'antd';
import { AppstoreOutlined, MenuOutlined, UnorderedListOutlined } from '@ant-design/icons';
import type { ReactNode } from 'react';

export type V2View = 'Overview' | 'Tasks';

export const V2_VIEWS: { key: V2View; label: string; description: string; icon: ReactNode }[] = [
  { key: 'Overview', label: '总览', description: '工作流指挥台：开发中、等待独立 Review、阻塞与下一步动作', icon: <AppstoreOutlined /> },
  { key: 'Tasks', label: '任务', description: '任务工作台：筛选、搜索、执行者与机器、详情', icon: <UnorderedListOutlined /> },
];

function Brand() {
  return <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '16px 16px 12px' }}>
    <span aria-hidden="true" style={{ width: 30, height: 30, borderRadius: 8, background: '#0d9488', color: '#fff',
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700 }}>A</span>
    <div style={{ minWidth: 0 }}>
      <Typography.Text strong style={{ display: 'block', lineHeight: 1.2 }}>AWH</Typography.Text>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>工作流中心 · V2 PoC</Typography.Text>
    </div>
  </div>;
}

/** Navigation and page frame only; it owns no dashboard data. */
export function AppShell({ view, onSelect, extra, children }: {
  view: V2View; onSelect: (view: V2View) => void; extra?: ReactNode; children: ReactNode;
}) {
  const screens = Grid.useBreakpoint();
  const isMobile = !screens.lg;
  const [navOpen, setNavOpen] = useState(false);
  const current = V2_VIEWS.find(item => item.key === view) ?? V2_VIEWS[0]!;
  const menu = <Menu mode="inline" selectedKeys={[view]} style={{ borderInlineEnd: 'none' }}
    items={V2_VIEWS.map(item => ({ key: item.key, icon: item.icon, label: item.label }))}
    onClick={({ key }) => { onSelect(key as V2View); setNavOpen(false); }} />;

  return <Layout style={{ minHeight: '100vh' }}>
    {!isMobile && <Layout.Sider width={208} theme="light" style={{ borderInlineEnd: '1px solid #e6ebef' }}>
      <Brand />{menu}
    </Layout.Sider>}
    <Layout style={{ minWidth: 0 }}>
      <Layout.Header style={{ display: 'flex', alignItems: 'center', gap: 12, borderBottom: '1px solid #e6ebef', padding: '0 12px' }}>
        {isMobile && <Button type="text" aria-label="打开导航" icon={<MenuOutlined />} onClick={() => setNavOpen(true)} />}
        <div style={{ flex: 1, minWidth: 0 }}>
          <Typography.Text strong style={{ fontSize: 16 }}>{current.label}</Typography.Text>
          {!isMobile && <Typography.Text type="secondary" style={{ fontSize: 12, marginInlineStart: 8 }}>{current.description}</Typography.Text>}
        </div>
        {extra}
      </Layout.Header>
      <Layout.Content style={{ padding: isMobile ? 12 : 20 }}>{children}</Layout.Content>
    </Layout>
    {isMobile && <Drawer open={navOpen} onClose={() => setNavOpen(false)} placement="left" size={240}
      title="导航" styles={{ body: { padding: 0 } }}><Brand />{menu}</Drawer>}
  </Layout>;
}
