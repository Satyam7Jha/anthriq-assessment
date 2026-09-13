export interface Segment<T extends string> {
  value: T;
  label: string;
}

export interface SegmentedControlProps<T extends string> {
  label: string;
  options: Segment<T>[];
  value: T;
  onChange: (value: T) => void;
}

/** A single choice among a few options, exposed to assistive tech as a radio group. */
export function SegmentedControl<T extends string>({ label, options, value, onChange }: SegmentedControlProps<T>) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex shrink-0 overflow-hidden rounded-lg border border-line">
      {options.map((o) => {
        const selected = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(o.value)}
            className={`num h-8 min-w-11 px-3 text-[13px] font-medium transition not-first:border-l not-first:border-line ${selected ? 'bg-accent text-white' : 'bg-surface text-label-2 hover:bg-subtle hover:text-label'}`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
