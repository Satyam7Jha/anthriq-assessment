import type { ButtonHTMLAttributes, ReactNode } from 'react';

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Required: an icon has no visible text, so this is its accessible name. */
  label: string;
  active?: boolean;
  size?: 'md' | 'lg';
  children: ReactNode;
}

export function IconButton({ label, active, size = 'md', className = '', children, ...rest }: IconButtonProps) {
  const dims =
    size === 'lg'
      ? 'size-10 rounded-full bg-accent text-white shadow-[0_1px_2px_rgba(16,24,40,0.12)] hover:brightness-110 active:scale-95'
      : `size-9 rounded-lg border border-line ${active ? 'bg-subtle text-label' : 'bg-surface text-label-2 hover:bg-subtle hover:text-label'}`;
  return (
    <button type="button" aria-label={label} title={label} aria-pressed={active} className={`flex shrink-0 items-center justify-center transition ${dims} ${className}`} {...rest}>
      {children}
    </button>
  );
}
