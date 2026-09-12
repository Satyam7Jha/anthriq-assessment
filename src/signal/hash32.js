'use strict';
// 32-bit integer avalanche hash (xorshift-multiply).
//
// PLAN §5.2: every operation here is EXACTLY specified by ECMAScript — Math.imul, ^, >>> are
// integer ops with no implementation latitude, unlike Math.sin/cos/exp/pow/log which the spec
// leaves "implementation-approximated". That is the whole reason this function exists instead of
// a trigonometric carrier: the validator must recompute bit-identical values, possibly under a
// different V8 build, hours later.
//
// Pure. No I/O, no module state, no dependencies (enforced by tools/check-layering.mjs).

function hash32(c, n) {
  let x = (Math.imul(n | 0, 0x9e3779b1) ^ Math.imul(c + 1, 0x85ebca77)) >>> 0;
  x ^= x >>> 15;
  x = Math.imul(x, 0x2545f491) >>> 0;
  x ^= x >>> 13;
  return x >>> 0;
}

module.exports = { hash32 };
