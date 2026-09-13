// CRC-32C (Castagnoli, reflected polynomial 0x82F63B78). PLAN §4.3.
//
// Without a checksum a corrupted block is indistinguishable from a block of "incorrect values",
// muddying the validator's classification. CRC-32C rather than SHA-256: we defend against bit-rot and
// truncation, not adversaries, and node:crypto allocates a Hash per block. The table is built once;
// the loop allocates nothing.

const TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let crc = i;
  for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0x82f63b78 : crc >>> 1;
  TABLE[i] = crc >>> 0;
}

/** Running CRC state over buf[start, end). Chain it as `seed`, then pass it to crc32cFinish. */
export function crc32cUpdate(buf: Uint8Array, start = 0, end = buf.length, seed = 0xffffffff): number {
  let crc = seed >>> 0;
  for (let i = start; i < end; i++) crc = (crc >>> 8) ^ TABLE[(crc ^ buf[i]) & 0xff];
  return crc >>> 0;
}

export const crc32cFinish = (state: number): number => (state ^ 0xffffffff) >>> 0;

export const crc32c = (buf: Uint8Array, start = 0, end = buf.length): number => crc32cFinish(crc32cUpdate(buf, start, end));
