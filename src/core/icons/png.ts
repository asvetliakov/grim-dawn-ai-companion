/**
 * A minimal PNG encoder: raw RGBA in, 8-bit RGBA PNG out.
 *
 * Written rather than delegated to `sharp` on purpose. The only image operation
 * this tool performs is "wrap already-decoded pixels in a container a browser can
 * display" — the game ships one texture per icon, so there is nothing to crop,
 * scale or convert. Node's own zlib covers the rest, which keeps a native module
 * (and its Electron ABI rebuild) out of a project whose renderer must never link
 * against one anyway.
 */

import { openSync, readSync, closeSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const COLOR_TYPE_RGBA = 6;
const BIT_DEPTH = 8;

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.allocUnsafe(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.allocUnsafe(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/**
 * A cached icon's dimensions, without decoding the image.
 *
 * IHDR is the first chunk of every PNG and its width/height are big-endian u32
 * at bytes 16 and 20, so 24 bytes off the front is the whole answer. That
 * matters because the UI asks for the size of every icon it draws and the
 * common case is a cache hit — inflating a few hundred images to learn their
 * width would be the one place this tool did real image work.
 *
 * Returns undefined for anything that is not a PNG we wrote, rather than
 * throwing: a corrupt cache entry should cost that item its grid footprint,
 * not the window.
 */
export function readPngSize(path: string): { width: number; height: number } | undefined {
  const head = Buffer.allocUnsafe(24);
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch {
    return undefined;
  }
  try {
    if (readSync(fd, head, 0, 24, 0) < 24) return undefined;
  } catch {
    return undefined;
  } finally {
    closeSync(fd);
  }
  if (!head.subarray(0, 8).equals(SIGNATURE) || head.toString('latin1', 12, 16) !== 'IHDR') return undefined;
  const width = head.readUInt32BE(16);
  const height = head.readUInt32BE(20);
  return width > 0 && height > 0 ? { width, height } : undefined;
}

export function encodePng(width: number, height: number, rgba: Buffer): Buffer {
  const expected = width * height * 4;
  if (rgba.length !== expected) {
    throw new Error(`expected ${expected} bytes of RGBA for ${width}×${height}, got ${rgba.length}`);
  }

  // Every scanline is prefixed with its filter type. None (0) is the honest
  // choice for 32×64 icons: the alternatives buy a few hundred bytes on images
  // that are already only a few KB.
  const stride = width * 4;
  const raw = Buffer.allocUnsafe(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  const ihdr = Buffer.allocUnsafe(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = BIT_DEPTH;
  ihdr[9] = COLOR_TYPE_RGBA;
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
