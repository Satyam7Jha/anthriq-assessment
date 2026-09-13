import type { ButtonHTMLAttributes, ReactNode } from 'react';

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Required: an icon has no visible text, so this is its accessible name. */
  label: string;
  active?: boolean;
  size?: 'md' | 'lg';
  children: ReactNode;
}

export function IconButton({ label, active, size = 'md', className = '', children, ...rest }: IconButtonProps) {
  const dims = size === 'lg' ? 'size-9 rounded-full bg-label text-bg active:scale-95' : `size-8 rounded-lg ${active ? 'bg-fill text-label' : 'text-label-2 hover:bg-fill'}`;
  return (
    <button type="button" aria-label={label} title={label} aria-pressed={active} className={`flex shrink-0 items-center justify-center transition ${dims} ${className}`} {...rest}>
      {children}
    </button>
  );
}
