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
    <div role="radiogroup" aria-label={label} className="flex rounded-lg bg-fill p-0.5">
      {options.map((o) => {
        const selected = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(o.value)}
            className={`num h-7 flex-1 rounded-[7px] text-[12px] font-medium transition ${selected ? 'bg-surface text-label shadow-[0_1px_3px_rgba(0,0,0,0.12)]' : 'text-label-2 hover:text-label'}`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
