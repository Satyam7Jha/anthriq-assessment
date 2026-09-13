// 32-bit integer avalanche hash (xorshift-multiply).
//
// Every operation here is exactly specified by ECMAScript — Math.imul, ^ and >>> are integer ops with
// no implementation latitude, unlike Math.sin/cos/exp/pow/log, which the spec leaves
// "implementation-approximated". That is why this exists instead of a trigonometric carrier: the
// validator must recompute bit-identical values, possibly under a different V8 build, hours later.

export function hash32(c: number, n: number): number {
  let x = (Math.imul(n | 0, 0x9e3779b1) ^ Math.imul(c + 1, 0x85ebca77)) >>> 0;
  x ^= x >>> 15;
  x = Math.imul(x, 0x2545f491) >>> 0;
  x ^= x >>> 13;
  return x >>> 0;
}
