'use strict';
// Structured NDJSON to stderr, rate-limited. Structured because the bench harness parses it;
// stderr because stdout is reserved for data (`sigctl read | head` must work).

function createLogger({ component, quiet = false, stream = process.stderr } = {}) {
  const lastAt = new Map();
  function emit(level, event, fields) {
    if (quiet && level === 'info') return;
    stream.write(`${JSON.stringify({ t: new Date().toISOString(), level, component, event, ...fields })}\n`);
  }
  return {
    info: (event, fields) => emit('info', event, fields),
    warn: (event, fields) => emit('warn', event, fields),
    error: (event, fields) => emit('error', event, fields),
    /** At most one line per `ms` for this event key — log spam under overload is its own failure. */
    throttled(level, event, fields, ms = 1000) {
      const now = Date.now();
      if ((lastAt.get(event) ?? 0) + ms > now) return;
      lastAt.set(event, now);
      emit(level, event, fields);
    },
  };
}

module.exports = { createLogger };
