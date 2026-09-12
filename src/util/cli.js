'use strict';
// Tiny zero-dependency argv parser. PLAN: zero runtime dependencies is a claim the acquisition path
// makes, so the CLI parser is 40 lines rather than a package.
//
// Supports:  --flag  --no-flag  --key value  --key=value  -k value  and positional arguments.

function parseArgv(argv = process.argv.slice(2), { booleans = [], aliases = {} } = {}) {
  const opts = {};
  const positional = [];
  const isBool = (k) => booleans.includes(k);

  for (let i = 0; i < argv.length; i++) {
    let a = argv[i];
    if (a === '--') {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (!a.startsWith('-') || a === '-') {
      positional.push(a);
      continue;
    }
    a = a.replace(/^--?/, '');
    let value;
    const eq = a.indexOf('=');
    if (eq !== -1) {
      value = a.slice(eq + 1);
      a = a.slice(0, eq);
    }
    if (a.startsWith('no-') && value === undefined && isBool(camel(a.slice(3)))) {
      opts[camel(a.slice(3))] = false;
      continue;
    }
    const key = camel(aliases[a] ?? a);
    if (value !== undefined) opts[key] = coerce(value);
    else if (isBool(key)) opts[key] = true;
    else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) opts[key] = coerce(argv[++i]);
    else opts[key] = true;
  }
  return { opts, positional };
}

function camel(s) {
  return s.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());
}

function coerce(v) {
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v !== '' && !Number.isNaN(Number(v))) return Number(v);
  return v;
}

/** Parse "12.5s" | "#50000" | "1:30" | "90" into a frame index. Used by sigctl/sigplay. */
function parsePosition(spec, sampleRateHz) {
  if (spec === undefined || spec === null || spec === '') return null;
  const s = String(spec).trim();
  if (s.startsWith('#')) return Math.round(Number(s.slice(1))); // explicit frame index
  if (/^\d+:\d+(\.\d+)?$/.test(s)) {
    const [m, sec] = s.split(':');
    return Math.round((Number(m) * 60 + Number(sec)) * sampleRateHz);
  }
  const m = s.match(/^(-?[\d.]+)\s*(ms|s|m|h)?$/);
  if (!m) throw new Error(`cannot parse position ${JSON.stringify(spec)} (try "12.5s", "#50000", "1:30")`);
  const n = Number(m[1]);
  const mult = { ms: 1e-3, s: 1, m: 60, h: 3600 }[m[2] ?? 's'];
  return Math.round(n * mult * sampleRateHz);
}

module.exports = { parseArgv, parsePosition, camel };
