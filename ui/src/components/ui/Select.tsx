export interface SelectProps {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
}

/** A compact labelled menu: "Speed 1×". Native select underneath, so keyboard and screen readers just work. */
export function Select({ label, value, options, onChange }: SelectProps) {
  return (
    <label className="relative flex h-7 shrink-0 items-center rounded-lg bg-fill pl-2.5 pr-6 text-[12px] focus-within:outline-2 focus-within:outline-focus">
      <span className="mr-1.5 text-label-2">{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)} className="num appearance-none bg-transparent font-medium text-label outline-none">
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <svg aria-hidden className="pointer-events-none absolute right-2" width="7" height="10" viewBox="0 0 7 10" fill="none" stroke="currentColor" strokeWidth="1.3" opacity="0.5">
        <path d="M1 3.5 3.5 1 6 3.5M1 6.5 3.5 9 6 6.5" />
      </svg>
    </label>
  );
}
