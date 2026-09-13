/** A small indeterminate spinner. Decorative: the text beside it says what is happening. */
export function Spinner({ size = 14, className = '' }: { size?: number; className?: string }) {
  return (
    <svg aria-hidden width={size} height={size} viewBox="0 0 16 16" fill="none" className={`shrink-0 animate-spin ${className}`}>
      <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2" />
      <path d="M14.5 8A6.5 6.5 0 0 0 8 1.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
