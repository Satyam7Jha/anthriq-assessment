export type Status = 'pass' | 'warn' | 'fail';

const TONE: Record<Status, string> = { pass: 'text-green', warn: 'text-orange', fail: 'text-red' };

/** A filled circle with a check or a cross. Decorative: the adjacent text carries the meaning. */
export function StatusIcon({ status, size = 22 }: { status: Status; size?: number }) {
  return (
    <svg aria-hidden width={size} height={size} viewBox="0 0 22 22" className={`shrink-0 ${TONE[status]}`} fill="currentColor">
      <circle cx="11" cy="11" r="11" />
      {status === 'fail' ? (
        <path d="M7.5 7.5l7 7M14.5 7.5l-7 7" stroke="white" strokeWidth="2" strokeLinecap="round" />
      ) : (
        <path d="M6.5 11.3l3 3 6-6.3" stroke="white" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      )}
    </svg>
  );
}

export const statusTone = (status: Status): string => TONE[status];
