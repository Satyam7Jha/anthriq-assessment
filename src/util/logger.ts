// Structured NDJSON on stderr. Structured because the benches parse it; stderr because stdout is
// reserved for data (`sigctl read | head` must work).

type Fields = Record<string, unknown>;
type Level = 'info' | 'warn' | 'error';

export interface Logger {
  info: (event: string, fields?: Fields) => void;
  warn: (event: string, fields?: Fields) => void;
  error: (event: string, fields?: Fields) => void;
  /** At most one line per `ms` for this event — log spam under overload is its own failure. */
  throttled: (level: Level, event: string, fields?: Fields, ms?: number) => void;
}

export function createLogger({ component, quiet = false }: { component: string; quiet?: boolean }): Logger {
  const lastAt = new Map<string, number>();
  const emit = (level: Level, event: string, fields: Fields = {}) => {
    if (quiet && level === 'info') return;
    process.stderr.write(`${JSON.stringify({ t: new Date().toISOString(), level, component, event, ...fields })}\n`);
  };
  return {
    info: (event, fields) => emit('info', event, fields),
    warn: (event, fields) => emit('warn', event, fields),
    error: (event, fields) => emit('error', event, fields),
    throttled(level, event, fields, ms = 1000) {
      const now = Date.now();
      if ((lastAt.get(event) ?? 0) + ms > now) return;
      lastAt.set(event, now);
      emit(level, event, fields);
    },
  };
}
