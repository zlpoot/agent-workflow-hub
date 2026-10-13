import { Card, Statistic, Typography } from 'antd';
import type { ReactNode } from 'react';

/** One metric + its provenance note. The note keeps every number tied to its source. */
export function MetricCard({ title, value, note, icon, tone }: {
  title: string; value: number; note: string; icon?: ReactNode; tone?: 'attention' | 'blocked' | 'healthy' | 'neutral';
}) {
  const color = tone === 'blocked' ? '#d4380d' : tone === 'attention' ? '#d46b08' : tone === 'healthy' ? '#16a34a' : undefined;
  return <Card size="small" styles={{ body: { padding: 16 } }}>
    <Statistic title={title} value={value} prefix={icon}
      styles={{ content: { color, fontSize: 28, fontWeight: 600 } }} />
    <Typography.Text type="secondary" style={{ fontSize: 12 }}>{note}</Typography.Text>
  </Card>;
}
