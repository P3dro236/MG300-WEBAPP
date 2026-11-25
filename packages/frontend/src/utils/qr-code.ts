/**
 * Deterministic dependency-free ISO/IEC 18004 QR Code matrix generator
 * supporting Byte mode with EC Level L for Versions 1..4 (up to 78 UTF-8 bytes).
 */

export interface QrMatrix {
  size: number;
  modules: boolean[][];
}

interface VersionSpec {
  version: number;
  size: number;
  totalCodewords: number;
  dataCodewords: number;
  ecCodewords: number;
  alignCenter: number | null;
}

const VERSION_SPECS: readonly VersionSpec[] = [
  { version: 1, size: 21, totalCodewords: 26, dataCodewords: 19, ecCodewords: 7, alignCenter: null },
  { version: 2, size: 25, totalCodewords: 44, dataCodewords: 34, ecCodewords: 10, alignCenter: 18 },
  { version: 3, size: 29, totalCodewords: 70, dataCodewords: 55, ecCodewords: 15, alignCenter: 22 },
  { version: 4, size: 33, totalCodewords: 100, dataCodewords: 80, ecCodewords: 20, alignCenter: 26 },
];

// GF(256) with primitive polynomial 0x11d (ISO/IEC 18004)
const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) {
      x ^= 0x11d;
    }
  }
  for (let i = 255; i < 512; i++) {
    GF_EXP[i] = GF_EXP[i - 255]!;
  }
})();

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a]! + GF_LOG[b]!]!;
}

function computeRsEc(data: Uint8Array, ecLen: number): Uint8Array {
  let poly: number[] = [1];
  for (let i = 0; i < ecLen; i++) {
    const next: number[] = new Array<number>(poly.length + 1).fill(0);
    const root = GF_EXP[i]!;
    for (let j = 0; j < poly.length; j++) {
      next[j]! ^= poly[j]!;
      next[j + 1]! ^= gfMul(poly[j]!, root);
    }
    poly = next;
  }

  const work = new Uint8Array(data.length + ecLen);
  work.set(data, 0);
  for (let i = 0; i < data.length; i++) {
    const factor = work[i]!;
    if (factor !== 0) {
      for (let j = 0; j < poly.length; j++) {
        work[i + j]! ^= gfMul(poly[j]!, factor);
      }
    }
  }
  return work.slice(data.length);
}

function computeFormatBits(maskPattern: number): number {
  // EC Level L = 01 (bits 01 + 3-bit mask)
  const data = (0b01 << 3) | (maskPattern & 0b111);
  let rem = data << 10;
  const gen = 0b10100110111;
  for (let bit = 14; bit >= 10; bit--) {
    if ((rem >>> bit) & 1) {
      rem ^= gen << (bit - 10);
    }
  }
  return ((data << 10) | rem) ^ 0b101010000010010;
}

function utf8Bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

export function generateQrMatrix(text: string): QrMatrix | null {
  const payload = utf8Bytes(text);
  // Byte mode overhead: 4 mode bits + 8 length bits + 4 terminator bits => max floor((dataCodewords*8 - 12)/8) bytes
  const spec = VERSION_SPECS.find((v) => payload.length <= v.dataCodewords - 2);
  if (!spec) {
    return null;
  }

  // Encode bits: mode 0100 (4b), count (8b), data, terminator (<=4b), zero pad, 0xEC/0x11 pad
  const bits: number[] = [];
  const pushBits = (val: number, count: number): void => {
    for (let i = count - 1; i >= 0; i--) {
      bits.push((val >>> i) & 1);
    }
  };

  pushBits(0b0100, 4);
  pushBits(payload.length, 8);
  for (const b of payload) {
    pushBits(b, 8);
  }
  const capacityBits = spec.dataCodewords * 8;
  const terminatorLen = Math.min(4, capacityBits - bits.length);
  pushBits(0, terminatorLen);
  while (bits.length % 8 !== 0) {
    bits.push(0);
  }

  const dataBytes = new Uint8Array(spec.dataCodewords);
  for (let i = 0; i < bits.length / 8; i++) {
    let val = 0;
    for (let b = 0; b < 8; b++) {
      val = (val << 1) | bits[i * 8 + b]!;
    }
    dataBytes[i] = val;
  }
  const padBytes = [0xec, 0x11];
  for (let i = bits.length / 8, p = 0; i < spec.dataCodewords; i++, p++) {
    dataBytes[i] = padBytes[p % 2]!;
  }

  const ecBytes = computeRsEc(dataBytes, spec.ecCodewords);
  const fullStream = new Uint8Array(spec.totalCodewords);
  fullStream.set(dataBytes, 0);
  fullStream.set(ecBytes, dataBytes.length);

  const size = spec.size;
  const modules: boolean[][] = Array.from({ length: size }, () =>
    new Array<boolean>(size).fill(false),
  );
  const isReserved: boolean[][] = Array.from({ length: size }, () =>
    new Array<boolean>(size).fill(false),
  );

  const setFixed = (r: number, c: number, dark: boolean): void => {
    if (r >= 0 && r < size && c >= 0 && c < size) {
      modules[r]![c] = dark;
      isReserved[r]![c] = true;
    }
  };

  const drawFinder = (top: number, left: number): void => {
    for (let dr = -1; dr <= 7; dr++) {
      for (let dc = -1; dc <= 7; dc++) {
        const r = top + dr;
        const c = left + dc;
        if (r < 0 || r >= size || c < 0 || c >= size) continue;
        const inBorder = dr === 0 || dr === 6 || dc === 0 || dc === 6;
        const inCore = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;
        const inFrame = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6;
        setFixed(r, c, inFrame && (inBorder || inCore));
      }
    }
  };

  drawFinder(0, 0);
  drawFinder(0, size - 7);
  drawFinder(size - 7, 0);

  if (spec.alignCenter !== null) {
    const center = spec.alignCenter;
    for (let dr = -2; dr <= 2; dr++) {
      for (let dc = -2; dc <= 2; dc++) {
        const dark =
          Math.abs(dr) === 2 || Math.abs(dc) === 2 || (dr === 0 && dc === 0);
        setFixed(center + dr, center + dc, dark);
      }
    }
  }

  for (let i = 8; i < size - 8; i++) {
    setFixed(6, i, i % 2 === 0);
    setFixed(i, 6, i % 2 === 0);
  }

  // Reserve format info areas and dark module
  for (let i = 0; i < 9; i++) {
    if (i !== 6) {
      isReserved[8]![i] = true;
      isReserved[i]![8] = true;
    }
  }
  for (let i = 0; i < 8; i++) {
    isReserved[8]![size - 1 - i] = true;
  }
  for (let i = 0; i < 7; i++) {
    isReserved[size - 1 - i]![8] = true;
  }
  setFixed(size - 8, 8, true);

  // Place data bits (mask 0: (r + c) % 2 === 0)
  const maskPattern = 0;
  let bitIdx = 0;
  const totalBits = fullStream.length * 8;
  let upward = true;
  for (let col = size - 1; col >= 1; col -= 2) {
    if (col === 6) {
      col -= 1;
    }
    for (let step = 0; step < size; step++) {
      const r = upward ? size - 1 - step : step;
      for (let dx = 0; dx < 2; dx++) {
        const c = col - dx;
        if (isReserved[r]![c]) {
          continue;
        }
        let bit = false;
        if (bitIdx < totalBits) {
          const byteVal = fullStream[bitIdx >>> 3]!;
          bit = ((byteVal >>> (7 - (bitIdx & 7))) & 1) === 1;
          bitIdx += 1;
        }
        const maskBit = (r + c) % 2 === 0;
        modules[r]![c] = bit !== maskBit;
      }
    }
    upward = !upward;
  }

  // Write 15-bit format information (MSB bit 14 -> LSB bit 0) per ISO/IEC 18004 Sec 7.9
  const fmt = computeFormatBits(maskPattern);
  for (let i = 0; i <= 5; i++) {
    const bit = ((fmt >>> (14 - i)) & 1) === 1;
    modules[8]![i] = bit;
    modules[size - 1 - i]![8] = bit;
  }
  modules[8]![7] = ((fmt >>> 8) & 1) === 1;
  modules[size - 7]![8] = ((fmt >>> 8) & 1) === 1;
  modules[8]![8] = ((fmt >>> 7) & 1) === 1;
  modules[8]![size - 8] = ((fmt >>> 7) & 1) === 1;
  modules[7]![8] = ((fmt >>> 6) & 1) === 1;
  modules[8]![size - 7] = ((fmt >>> 6) & 1) === 1;
  for (let i = 9; i < 15; i++) {
    const bit = ((fmt >>> (14 - i)) & 1) === 1;
    modules[14 - i]![8] = bit;
    modules[8]![size - 15 + i] = bit;
  }

  return { size, modules };
}
