export type Status = 'pass' | 'warn' | 'fail' | 'pending';

const TONE: Record<Status, string> = { pass: 'text-green', warn: 'text-orange', fail: 'text-red', pending: 'text-label-3' };

/** A check, an exclamation mark, a cross, or an empty ring for "not checked yet". Decorative: the adjacent text carries the meaning. */
export function StatusIcon({ status, size = 22 }: { status: Status; size?: number }) {
  return (
    <svg aria-hidden width={size} height={size} viewBox="0 0 22 22" className={`shrink-0 ${TONE[status]}`} fill="currentColor">
      {status === 'pending' ? (
        <circle cx="11" cy="11" r="9.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
      ) : (
        <circle cx="11" cy="11" r="11" />
      )}
      {status === 'fail' && <path d="M7.5 7.5l7 7M14.5 7.5l-7 7" stroke="white" strokeWidth="2" strokeLinecap="round" />}
      {status === 'pass' && <path d="M6.5 11.3l3 3 6-6.3" stroke="white" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />}
      {status === 'warn' && (
        <>
          <path d="M11 6v6.2" stroke="white" strokeWidth="2.2" strokeLinecap="round" />
          <circle cx="11" cy="15.6" r="1.3" fill="white" />
        </>
      )}
    </svg>
  );
}

export const statusTone = (status: Status): string => TONE[status];
