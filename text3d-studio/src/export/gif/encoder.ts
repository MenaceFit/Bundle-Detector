import { lzwEncode } from './lzw';
import { createPaletteMapper, type Palette } from './quantize';

/**
 * Minimal GIF89a writer with a global palette, one reserved transparent index
 * and a Netscape looping extension.
 */
export class GifEncoder {
  private readonly chunks: Uint8Array[] = [];
  private readonly mapper: (r: number, g: number, b: number) => number;
  private readonly tableBits: number;
  private readonly transparentIndex: number;

  constructor(
    private readonly width: number,
    private readonly height: number,
    palette: Palette,
    private readonly options: { loop: boolean; alphaThreshold?: number },
  ) {
    this.mapper = createPaletteMapper(palette);
    // One index is reserved for transparency, so at most 255 colours are usable.
    this.transparentIndex = Math.min(palette.size, 255);
    // The table must hold every palette entry plus the transparent slot.
    this.tableBits = Math.min(
      8,
      Math.max(1, Math.ceil(Math.log2(Math.max(2, this.transparentIndex + 1)))),
    );
    this.writeHeader(palette);
  }

  private push(bytes: number[] | Uint8Array): void {
    this.chunks.push(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
  }

  private writeHeader(palette: Palette): void {
    const tableSize = 1 << this.tableBits;

    this.push([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]); // "GIF89a"
    this.push([
      this.width & 0xff,
      (this.width >> 8) & 0xff,
      this.height & 0xff,
      (this.height >> 8) & 0xff,
      // global colour table present | 8-bit colour resolution | table size
      0x80 | 0x70 | (this.tableBits - 1),
      0,
      0,
    ]);

    const table = new Uint8Array(tableSize * 3);
    table.set(palette.colors.subarray(0, Math.min(palette.colors.length, table.length)));
    this.push(table);

    if (this.options.loop) {
      this.push([
        0x21,
        0xff,
        0x0b,
        ...[...'NETSCAPE2.0'].map((c) => c.charCodeAt(0)),
        0x03,
        0x01,
        0x00,
        0x00,
        0x00,
      ]);
    }
  }

  /** Adds one frame. `delayMs` is rounded to the 10 ms GIF tick. */
  addFrame(pixels: Uint8ClampedArray, delayMs: number): void {
    const threshold = this.options.alphaThreshold ?? 128;
    const count = this.width * this.height;
    const indices = new Uint8Array(count);

    for (let i = 0; i < count; i += 1) {
      const offset = i * 4;
      indices[i] =
        pixels[offset + 3]! < threshold
          ? this.transparentIndex
          : this.mapper(pixels[offset]!, pixels[offset + 1]!, pixels[offset + 2]!);
    }

    const delay = Math.max(2, Math.round(delayMs / 10));

    // Graphic control extension: disposal 2 (restore to background) is what
    // keeps transparent pixels from accumulating across frames.
    this.push([0x21, 0xf9, 0x04, 0x09, delay & 0xff, (delay >> 8) & 0xff, this.transparentIndex, 0x00]);

    this.push([
      0x2c,
      0,
      0,
      0,
      0,
      this.width & 0xff,
      (this.width >> 8) & 0xff,
      this.height & 0xff,
      (this.height >> 8) & 0xff,
      0x00,
    ]);

    const minCodeSize = Math.max(2, this.tableBits);
    this.push([minCodeSize]);
    this.push(lzwEncode(indices, minCodeSize));
  }

  finish(): Uint8Array {
    this.push([0x3b]);
    const total = this.chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }
}
