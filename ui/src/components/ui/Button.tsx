import type { ButtonHTMLAttributes } from 'react';

type Variant = 'primary' | 'secondary' | 'plain';

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-accent text-white hover:brightness-110',
  secondary: 'bg-fill text-accent hover:bg-fill-strong',
  plain: 'text-label-2 hover:bg-fill hover:text-label',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  block?: boolean;
}

/** The one text button. Three variants; nothing else in the app styles its own. */
export function Button({ variant = 'secondary', block, className = '', ...rest }: ButtonProps) {
  return (
    <button
      type="button"
      className={`inline-flex h-8 items-center justify-center gap-2 rounded-lg px-3 text-[13px] font-medium transition active:scale-[0.99] disabled:pointer-events-none disabled:opacity-50 ${VARIANTS[variant]} ${block ? 'w-full' : ''} ${className}`}
      {...rest}
    />
  );
}
