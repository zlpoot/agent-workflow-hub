import { Tag, Tooltip } from 'antd';
import { REVIEW_GATE_LABELS, REVIEW_GATE_SOURCE_LABELS, stateColor, stateLabel } from '../semantics.js';

const flush = { marginInlineEnd: 0 } as const;

/** Single status vocabulary for every page: a contract value in, one readable tag out. */
export function StatusTag({ value, note }: { value: string | null | undefined; note?: string }) {
  const tag = <Tag color={stateColor(value)} style={flush}>{stateLabel(value)}</Tag>;
  return note ? <Tooltip title={note}>{tag}</Tooltip> : tag;
}

export function FixtureTag() {
  return <Tag color="gold" style={flush}>模拟数据</Tag>;
}

export function AuthorityTag() {
  return <Tag color="default" style={flush}>GitHub 授权未核验</Tag>;
}

export function ReviewGateTag({ status, source }: { status: string; source: string }) {
  const color = status === 'passed' ? 'success' : status === 'changes_requested' ? 'orange'
    : status === 'stale' ? 'red' : status === 'pending' ? 'gold' : 'default';
  return <Tag color={color} style={flush}>Review Gate：{REVIEW_GATE_LABELS[status] ?? status} · {REVIEW_GATE_SOURCE_LABELS[source] ?? source}</Tag>;
}
