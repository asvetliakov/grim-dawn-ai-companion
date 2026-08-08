/**
 * Decoding Grim Dawn's `.tex` textures to raw pixels.
 *
 * A `.tex` is a 12-byte wrapper around a DDS: `TEX` + a version byte, a reserved
 * u32, then the byte length of the DDS that follows. The DDS itself is standard
 * except that its magic reads `DDSR` rather than `DDS ` — the header behind it is
 * the usual 124-byte `DDSURFACEDESC2`.
 *
 * Every texture an item's `bitmap` field points at is uncompressed and
 * bottom-of-the-pipeline simple: 32 bits per pixel, BGRA byte order, one mip
 * level, rows packed tight and top-down (verified across all 3,844 icon paths in
 * 1.3.0.6 — 3,843 at 32bpp, one at 24). The DXT1/3/5 textures that fill the rest
 * of the archive are model skins, never icons, so this decoder reports them as
 * unsupported instead of carrying a block decompressor nothing calls.
 */

/** The pixel-format masks are all zero in these files; byte order is fixed BGRA. */
const DDPF_FOURCC = 0x4;
const DDSD_PITCH = 0x8;
const DDS_HEADER_SIZE = 128;

export interface DecodedTexture {
  width: number;
  height: number;
  /** Tightly packed RGBA, 4 bytes per pixel, top row first. */
  rgba: Buffer;
}

/** Thrown for a well-formed texture in a format we deliberately do not decode. */
export class UnsupportedTextureError extends Error {}

export function decodeTex(buf: Buffer): DecodedTexture {
  if (buf.length < 12 || buf.toString('latin1', 0, 3) !== 'TEX') {
    throw new Error(`not a .tex: header reads ${JSON.stringify(buf.toString('latin1', 0, 4))}`);
  }
  const declared = buf.readUInt32LE(8);
  const dds = buf.subarray(12, 12 + declared);
  if (dds.length < declared) throw new Error(`.tex declares ${declared} bytes of DDS but carries ${dds.length}`);
  return decodeDds(dds);
}

export function decodeDds(dds: Buffer): DecodedTexture {
  // The game writes `DDSR` where the standard writes `DDS `; everything after
  // the magic is an ordinary DDS header, so only the first three bytes are worth
  // checking.
  if (dds.length < DDS_HEADER_SIZE || dds.toString('latin1', 0, 3) !== 'DDS') {
    throw new Error(`not a DDS: magic reads ${JSON.stringify(dds.toString('latin1', 0, 4))}`);
  }

  const flags = dds.readUInt32LE(8);
  const height = dds.readUInt32LE(12);
  const width = dds.readUInt32LE(16);
  const pitchOrLinear = dds.readUInt32LE(20);
  const pixelFormatFlags = dds.readUInt32LE(80);
  const fourCC = dds.toString('latin1', 84, 88);
  const bitsPerPixel = dds.readUInt32LE(88);

  if (pixelFormatFlags & DDPF_FOURCC) {
    throw new UnsupportedTextureError(`compressed texture (${fourCC.replace(/\0/g, '')}) — icons are never compressed`);
  }
  if (bitsPerPixel !== 32 && bitsPerPixel !== 24) {
    throw new UnsupportedTextureError(`${bitsPerPixel}-bit pixels`);
  }
  if (width <= 0 || height <= 0) throw new Error(`DDS declares a ${width}×${height} image`);

  const bytesPerPixel = bitsPerPixel / 8;
  // Rows are tight in practice; honour an explicit pitch anyway, since a padded
  // row would otherwise shear the image one pixel further on every line.
  const pitch = flags & DDSD_PITCH && pitchOrLinear >= width * bytesPerPixel ? pitchOrLinear : width * bytesPerPixel;

  const needed = DDS_HEADER_SIZE + pitch * height;
  if (dds.length < needed) {
    throw new Error(`DDS is ${dds.length} bytes, too short for ${width}×${height} at ${bitsPerPixel}bpp (${needed})`);
  }

  const rgba = Buffer.allocUnsafe(width * height * 4);
  let out = 0;
  for (let y = 0; y < height; y++) {
    let src = DDS_HEADER_SIZE + y * pitch;
    for (let x = 0; x < width; x++) {
      // Stored BGRA; PNG wants RGBA. 24-bit textures have no alpha channel at
      // all, which for an icon means fully opaque rather than fully transparent.
      rgba[out++] = dds[src + 2]!;
      rgba[out++] = dds[src + 1]!;
      rgba[out++] = dds[src]!;
      rgba[out++] = bytesPerPixel === 4 ? dds[src + 3]! : 0xff;
      src += bytesPerPixel;
    }
  }
  return { width, height, rgba };
}
