import type { ButtonHTMLAttributes } from 'react';

type Variant = 'primary' | 'secondary' | 'plain' | 'danger';
type Size = 'md' | 'lg';

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-accent text-white shadow-[0_1px_2px_rgba(16,24,40,0.1)] hover:brightness-110',
  secondary: 'border border-line bg-surface text-label hover:bg-subtle',
  plain: 'text-label-2 hover:bg-fill hover:text-label',
  danger: 'bg-red text-white shadow-[0_1px_2px_rgba(16,24,40,0.12)] hover:brightness-110',
};

const SIZES: Record<Size, string> = {
  md: 'h-8 px-3 text-[13px]',
  lg: 'h-10 px-4 text-[14px]',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  block?: boolean;
}

/** The one text button. Four variants, two sizes; nothing else in the app styles its own. */
export function Button({ variant = 'secondary', size = 'md', block, className = '', ...rest }: ButtonProps) {
  return (
    <button
      type="button"
      className={`inline-flex items-center justify-center gap-2 rounded-lg font-medium whitespace-nowrap transition active:scale-[0.99] disabled:pointer-events-none disabled:opacity-50 ${SIZES[size]} ${VARIANTS[variant]} ${block ? 'w-full' : ''} ${className}`}
      {...rest}
    />
  );
}
