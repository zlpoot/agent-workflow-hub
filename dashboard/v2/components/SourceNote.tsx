import { Typography } from 'antd';
import { AUTHORITY_NOTE, PROVENANCE_NOTE, REVIEW_NOTE } from '../semantics.js';

/** Persistent provenance footer: what the page shows is never a GitHub authorization fact. */
export function SourceNote({ extra }: { extra?: string }) {
  return <Typography.Paragraph type="secondary" style={{ fontSize: 12, margin: 0 }}>
    {PROVENANCE_NOTE} · {AUTHORITY_NOTE}<br />{REVIEW_NOTE}{extra ? ` · ${extra}` : ''}
  </Typography.Paragraph>;
}
