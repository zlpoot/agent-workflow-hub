import type { ReactNode, SelectHTMLAttributes } from "react";
export function Select({
  label,
  children,
  ...props
}: {
  label: string;
  children: ReactNode;
} & SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <label className="filter-label">
      {label}
      <select aria-label={label} {...props}>
        {children}
      </select>
    </label>
  );
}
