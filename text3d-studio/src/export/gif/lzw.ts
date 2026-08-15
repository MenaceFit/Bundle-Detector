/**
 * GIF variable-width LZW compressor.
 *
 * Codes are packed least-significant-bit first and emitted as sub-blocks of at
 * most 255 bytes, exactly as the GIF89a specification requires.
 */

class BitWriter {
  private readonly bytes: number[] = [];
  private accumulator = 0;
  private bits = 0;

  write(code: number, size: number): void {
    this.accumulator |= code << this.bits;
    this.bits += size;
    while (this.bits >= 8) {
      this.bytes.push(this.accumulator & 0xff);
      this.accumulator >>= 8;
      this.bits -= 8;
    }
  }

  finish(): number[] {
    if (this.bits > 0) {
      this.bytes.push(this.accumulator & 0xff);
      this.accumulator = 0;
      this.bits = 0;
    }
    return this.bytes;
  }
}

export function lzwEncode(indices: Uint8Array, minCodeSize: number): Uint8Array {
  const clearCode = 1 << minCodeSize;
  const endCode = clearCode + 1;

  let codeSize = minCodeSize + 1;
  let next = endCode + 1;
  let dictionary = new Map<number, number>();

  const writer = new BitWriter();
  writer.write(clearCode, codeSize);

  if (indices.length === 0) {
    writer.write(endCode, codeSize);
    return toSubBlocks(writer.finish());
  }

  let prefix = indices[0]!;

  for (let i = 1; i < indices.length; i += 1) {
    const suffix = indices[i]!;
    // prefix < 4096 and suffix < 256, so this key is collision-free.
    const composite = prefix * 4096 + suffix;
    const existing = dictionary.get(composite);

    if (existing !== undefined) {
      prefix = existing;
      continue;
    }

    writer.write(prefix, codeSize);

    if (next === 4096) {
      // The table is full: tell the decoder to start over.
      writer.write(clearCode, codeSize);
      dictionary = new Map();
      next = endCode + 1;
      codeSize = minCodeSize + 1;
    } else {
      // Widen *before* registering the new entry. A decoder only creates an
      // entry when it reads the following code, so its table always trails the
      // encoder's by one; widening after the insert would desynchronise the
      // two by exactly one code and corrupt the stream.
      if (next >= 1 << codeSize && codeSize < 12) codeSize += 1;
      dictionary.set(composite, next);
      next += 1;
    }

    prefix = suffix;
  }

  writer.write(prefix, codeSize);
  writer.write(endCode, codeSize);

  return toSubBlocks(writer.finish());
}

/** Wraps the raw code stream into length-prefixed blocks, terminated by 0x00. */
function toSubBlocks(bytes: number[]): Uint8Array {
  const blockCount = Math.ceil(bytes.length / 255);
  const out = new Uint8Array(bytes.length + blockCount + 1);
  let read = 0;
  let write = 0;

  while (read < bytes.length) {
    const size = Math.min(255, bytes.length - read);
    out[write] = size;
    write += 1;
    for (let i = 0; i < size; i += 1) {
      out[write] = bytes[read]!;
      write += 1;
      read += 1;
    }
  }

  out[write] = 0;
  return out.subarray(0, write + 1);
}
