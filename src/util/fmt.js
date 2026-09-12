'use strict';
// Formatting helpers. The thousands separators matter: the assessment's representative validator
// output uses them, and `test/fixtures/expected-pass.txt` is diffed byte-for-byte.

const n = (x) => Number(x).toLocaleString('en-US');

function bytes(b) {
  const u = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let i = 0;
  let v = Number(b);
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${i === 0 ? v : v.toFixed(4)} ${u[i]}`;
}

function duration(seconds) {
  const s = Number(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${sec.toFixed(3).padStart(6, '0')}`;
}

module.exports = { n, bytes, duration };
