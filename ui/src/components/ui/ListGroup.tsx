import type { ReactNode } from 'react';

/**
 * A titled section of the side column: full width, divided from the next by a hairline, no card
 * around it. The inspector is built only from these.
 */
export function ListGroup({ title, footer, children }: { title: string; footer?: ReactNode; children: ReactNode }) {
  return (
    <section aria-label={title} className="border-b border-line py-4">
      <h2 className="mb-1.5 px-5 text-[14px] font-semibold text-label">{title}</h2>
      <div>{children}</div>
      {footer && <p className="mt-2 px-5 text-[12px] leading-snug text-label-2">{footer}</p>}
    </section>
  );
}

const Divider = () => <div className="mx-5 h-px bg-line" />;

export function ListRow({ label, value, tone, last }: { label: string; value: ReactNode; tone?: 'red'; last?: boolean }) {
  return (
    <>
      <div className="flex min-h-9 items-center justify-between gap-4 px-5 text-[13px]">
        <span className="text-label-2">{label}</span>
        <span className={`num truncate text-right font-medium ${tone === 'red' ? 'text-red' : 'text-label'}`}>{value}</span>
      </div>
      {!last && <Divider />}
    </>
  );
}

export interface ListLinkProps {
  href: string;
  title: string;
  detail: string;
  /** Shown instead of the link, with the reason in `detail`. */
  disabled?: boolean;
  last?: boolean;
}

/** A row that downloads a file: what it is on the first line, format and size on the second. */
export function ListLink({ href, title, detail, disabled, last }: ListLinkProps) {
  const body = (
    <>
      <span className="min-w-0">
        <span className="block text-[13px] font-medium text-label">{title}</span>
        <span className="num mt-0.5 block text-[12px] leading-snug text-label-2">{detail}</span>
      </span>
      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-line text-accent">
        <svg aria-hidden width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M7 1.5v8M3.5 6.5 7 10l3.5-3.5M2 12.5h10" />
        </svg>
      </span>
    </>
  );
  return (
    <>
      {disabled ? (
        <div aria-disabled="true" className="flex items-center justify-between gap-3 px-5 py-2.5 opacity-45">
          {body}
        </div>
      ) : (
        <a href={href} download className="flex items-center justify-between gap-3 px-5 py-2.5 transition hover:bg-subtle focus-visible:rounded-none focus-visible:outline-offset-[-2px]">
          {body}
        </a>
      )}
      {!last && <Divider />}
    </>
  );
}
