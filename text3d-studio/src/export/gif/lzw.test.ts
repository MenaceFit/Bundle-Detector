import { describe, expect, it } from 'vitest';
import { lzwEncode } from './lzw';
import { createZip } from '../zip';

/**
 * Reference GIF LZW decoder, written independently of the encoder so a
 * round-trip really proves the bit packing, the code-width growth and the
 * sub-block framing are spec-correct.
 */
function lzwDecode(subBlocks: Uint8Array, minCodeSize: number): number[] {
  const data: number[] = [];
  let cursor = 0;
  while (cursor < subBlocks.length) {
    const size = subBlocks[cursor]!;
    cursor += 1;
    if (size === 0) break;
    for (let i = 0; i < size; i += 1) {
      data.push(subBlocks[cursor]!);
      cursor += 1;
    }
  }

  const clearCode = 1 << minCodeSize;
  const endCode = clearCode + 1;
  let codeSize = minCodeSize + 1;
  let dictionary: number[][] = [];

  const reset = (): void => {
    dictionary = [];
    for (let i = 0; i < clearCode; i += 1) dictionary.push([i]);
    dictionary.push([], []);
    codeSize = minCodeSize + 1;
  };
  reset();

  let bit = 0;
  const readCode = (): number => {
    let code = 0;
    for (let i = 0; i < codeSize; i += 1) {
      const byte = data[bit >> 3] ?? 0;
      code |= ((byte >> (bit & 7)) & 1) << i;
      bit += 1;
    }
    return code;
  };

  const out: number[] = [];
  let previous: number[] | null = null;

  for (;;) {
    if (bit >> 3 > data.length) throw new Error('flux LZW tronqué');
    const code = readCode();
    if (code === endCode) break;
    if (code === clearCode) {
      reset();
      previous = null;
      continue;
    }

    let entry: number[];
    const known = dictionary[code];
    if (known && known.length > 0) entry = known;
    else if (previous) entry = [...previous, previous[0]!];
    else throw new Error(`code invalide ${code}`);

    out.push(...entry);

    if (previous) {
      dictionary.push([...previous, entry[0]!]);
      if (dictionary.length === 1 << codeSize && codeSize < 12) codeSize += 1;
    }
    previous = entry;
  }

  return out;
}

function roundTrip(indices: number[], minCodeSize: number): number[] {
  return lzwDecode(lzwEncode(Uint8Array.from(indices), minCodeSize), minCodeSize);
}

describe('GIF LZW', () => {
  it('round-trips a single pixel', () => {
    expect(roundTrip([7], 8)).toEqual([7]);
  });

  it('round-trips a uniform run (worst case for the dictionary)', () => {
    const indices = new Array(5000).fill(3) as number[];
    expect(roundTrip(indices, 8)).toEqual(indices);
  });

  it('round-trips a repeating pattern', () => {
    const indices = Array.from({ length: 4096 }, (_, i) => i % 17);
    expect(roundTrip(indices, 8)).toEqual(indices);
  });

  it('round-trips pseudo-random data that fills the code table', () => {
    let seed = 12345;
    const indices = Array.from({ length: 20000 }, () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % 256;
    });
    expect(roundTrip(indices, 8)).toEqual(indices);
  });

  it('round-trips with a small palette and its narrower code size', () => {
    const indices = Array.from({ length: 3000 }, (_, i) => i % 4);
    expect(roundTrip(indices, 2)).toEqual(indices);
  });

  it('emits sub-blocks of at most 255 bytes, terminated by 0x00', () => {
    const encoded = lzwEncode(
      Uint8Array.from(Array.from({ length: 30000 }, (_, i) => i % 251)),
      8,
    );
    let cursor = 0;
    let blocks = 0;
    while (cursor < encoded.length) {
      const size = encoded[cursor]!;
      if (size === 0) break;
      expect(size).toBeLessThanOrEqual(255);
      cursor += size + 1;
      blocks += 1;
    }
    expect(blocks).toBeGreaterThan(1);
    expect(encoded[encoded.length - 1]).toBe(0);
  });
});

describe('ZIP writer', () => {
  it('writes the local, central and end-of-directory signatures', () => {
    const zip = createZip([{ name: 'frame_0.png', data: Uint8Array.from([1, 2, 3]) }]);
    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    expect(view.getUint32(0, true)).toBe(0x04034b50);
    expect(zip.length).toBeGreaterThan(60);

    const end = new DataView(zip.buffer, zip.byteOffset + zip.length - 22, 22);
    expect(end.getUint32(0, true)).toBe(0x06054b50);
    expect(end.getUint16(8, true)).toBe(1);
  });

  it('records every entry name', () => {
    const zip = createZip([
      { name: 'a.png', data: Uint8Array.from([1]) },
      { name: 'b.png', data: Uint8Array.from([2]) },
    ]);
    const text = new TextDecoder('latin1').decode(zip);
    expect(text).toContain('a.png');
    expect(text).toContain('b.png');

    const end = new DataView(zip.buffer, zip.byteOffset + zip.length - 22, 22);
    expect(end.getUint16(10, true)).toBe(2);
  });

  it('handles an empty archive', () => {
    const zip = createZip([]);
    expect(zip.length).toBe(22);
  });
});
