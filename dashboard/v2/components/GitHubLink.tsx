import { Typography } from 'antd';
import type { ReactNode } from 'react';

/** External GitHub links are built only from validated repository/number/SHA values. */
export function GitHubLink({ url, children }: { url: string | null; children: ReactNode }) {
  return url
    ? <a href={url} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">{children}<span aria-hidden="true"> ↗</span></a>
    : <Typography.Text type="secondary">{children}</Typography.Text>;
}
