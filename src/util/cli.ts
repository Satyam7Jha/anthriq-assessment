// A small argv parser: --flag, --no-flag, --key value, --key=value, -k value, positionals.
// Zero runtime dependencies is a claim the acquisition path makes, so this is 60 lines, not a package.

export type Opts = Record<string, string | number | boolean | undefined>;

const camel = (s: string): string => s.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());

function coerce(v: string): string | number | boolean {
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v !== '' && !Number.isNaN(Number(v))) return Number(v);
  return v;
}

export function parseArgv(
  argv: string[] = process.argv.slice(2),
  { booleans = [], aliases = {} }: { booleans?: string[]; aliases?: Record<string, string> } = {}
): { opts: Opts; positional: string[] } {
  const opts: Opts = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (!arg.startsWith('-') || arg === '-') {
      positional.push(arg);
      continue;
    }
    let name = arg.replace(/^--?/, '');
    let value: string | undefined;
    const eq = name.indexOf('=');
    if (eq !== -1) [name, value] = [name.slice(0, eq), name.slice(eq + 1)];
    if (name.startsWith('no-') && value === undefined && booleans.includes(camel(name.slice(3)))) {
      opts[camel(name.slice(3))] = false;
      continue;
    }
    const key = camel(aliases[name] ?? name);
    if (value !== undefined) opts[key] = coerce(value);
    else if (booleans.includes(key)) opts[key] = true;
    else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) opts[key] = coerce(argv[++i]);
    else opts[key] = true;
  }
  return { opts, positional };
}

/** "12.5s" | "#50000" (frame index) | "1:30" | "250ms" | "90" -> frame index, or null if absent. */
export function parsePosition(spec: unknown, sampleRateHz: number): number | null {
  if (spec === undefined || spec === null || spec === '') return null;
  const s = String(spec).trim();
  if (s.startsWith('#')) return Math.round(Number(s.slice(1)));
  if (/^\d+:\d+(\.\d+)?$/.test(s)) {
    const [m, sec] = s.split(':');
    return Math.round((Number(m) * 60 + Number(sec)) * sampleRateHz);
  }
  const m = s.match(/^(-?[\d.]+)\s*(ms|s|m|h)?$/);
  if (!m) throw new Error(`cannot parse position ${JSON.stringify(spec)} (try "12.5s", "#50000", "1:30")`);
  const unit = { ms: 1e-3, s: 1, m: 60, h: 3600 }[(m[2] ?? 's') as 'ms' | 's' | 'm' | 'h'];
  return Math.round(Number(m[1]) * unit * sampleRateHz);
}
