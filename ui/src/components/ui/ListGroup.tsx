import type { ReactNode } from 'react';

/** A titled, rounded group of rows — the inspector is built only from these. */
export function ListGroup({ title, footer, children }: { title: string; footer?: ReactNode; children: ReactNode }) {
  return (
    <section aria-label={title}>
      <h2 className="mb-1.5 px-4 text-[12px] font-medium text-label-2">{title}</h2>
      <div className="overflow-hidden rounded-xl bg-surface">{children}</div>
      {footer && <p className="mt-1.5 px-4 text-[12px] leading-snug text-label-2">{footer}</p>}
    </section>
  );
}

export function ListRow({ label, value, tone, last }: { label: string; value: ReactNode; tone?: 'red'; last?: boolean }) {
  return (
    <>
      <div className="flex min-h-10 items-center justify-between gap-4 px-4 text-[13px]">
        <span className="text-label">{label}</span>
        <span className={`num truncate text-right ${tone === 'red' ? 'text-red' : 'text-label-2'}`}>{value}</span>
      </div>
      {!last && <div className="ml-4 h-px bg-line" />}
    </>
  );
}
