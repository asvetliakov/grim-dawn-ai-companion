import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { ArcArchive } from '../src/core/db/arc.js';
import { findGameDir } from '../src/core/db/gamefiles.js';
import { createIconService, flatten } from '../src/core/icons/index.js';
import { encodePng } from '../src/core/icons/png.js';
import { UnsupportedTextureError, decodeTex } from '../src/core/icons/tex.js';
import { CHARACTERS, MISSING_GAME_MESSAGE, MISSING_SAVES_MESSAGE, characterSavePath, gameDb, haveGameInstall, haveSaves } from './paths.js';
import { parseGdc } from '../src/core/save/gdc.js';
import { resolveCharacter } from '../src/core/resolve.js';

// ---------------------------------------------------------------------------
// Synthetic textures — no game needed
// ---------------------------------------------------------------------------

const DDPF_RGB = 0x40;
const DDPF_FOURCC = 0x4;
const DDSD_PITCH = 0x8;

interface FakeTexOptions {
  bitsPerPixel?: number;
  fourCC?: string;
  /** Pad every row out to this many bytes, and set the pitch flag. */
  pitch?: number;
}

/** A `.tex` carrying `pixels` as rows of BGR(A) tuples, in the game's own layout. */
function makeTex(width: number, height: number, pixels: number[][], opts: FakeTexOptions = {}): Buffer {
  const bits = opts.bitsPerPixel ?? 32;
  const bytes = bits / 8;
  const pitch = opts.pitch ?? width * bytes;

  const dds = Buffer.alloc(128 + pitch * height);
  // The game writes `DDSR` where the standard writes `DDS ` — decoding has to
  // tolerate that, so the fixture reproduces it.
  dds.write('DDSR', 0, 'latin1');
  dds.writeUInt32LE(124, 4);
  dds.writeUInt32LE(0x1007 | (opts.pitch ? DDSD_PITCH : 0), 8);
  dds.writeUInt32LE(height, 12);
  dds.writeUInt32LE(width, 16);
  if (opts.pitch) dds.writeUInt32LE(pitch, 20);
  dds.writeUInt32LE(32, 76); // pixel-format struct size
  dds.writeUInt32LE(opts.fourCC ? DDPF_FOURCC : DDPF_RGB, 80);
  if (opts.fourCC) dds.write(opts.fourCC, 84, 'latin1');
  dds.writeUInt32LE(opts.fourCC ? 0 : bits, 88);

  pixels.forEach((pixel, i) => {
    const at = 128 + Math.floor(i / width) * pitch + (i % width) * bytes;
    for (let b = 0; b < bytes; b++) dds[at + b] = pixel[b] ?? 0;
  });

  const tex = Buffer.alloc(12 + dds.length);
  tex.write('TEX', 0, 'latin1');
  tex[3] = 2;
  tex.writeUInt32LE(dds.length, 8);
  dds.copy(tex, 12);
  return tex;
}

describe('.tex decoding', () => {
  it('reads BGRA pixels out as RGBA', () => {
    // Pure red and pure blue, stored blue-first: the one thing that would look
    // plausible and be wrong is a channel swap, so assert on it directly.
    const tex = makeTex(2, 1, [
      [0x00, 0x00, 0xff, 0xff],
      [0xff, 0x00, 0x00, 0x80],
    ]);
    const { width, height, rgba } = decodeTex(tex);
    expect([width, height]).toEqual([2, 1]);
    expect([...rgba]).toEqual([0xff, 0x00, 0x00, 0xff, 0x00, 0x00, 0xff, 0x80]);
  });

  it('treats a 24-bit texture as fully opaque', () => {
    const { rgba } = decodeTex(makeTex(1, 1, [[0x10, 0x20, 0x30]], { bitsPerPixel: 24 }));
    expect([...rgba]).toEqual([0x30, 0x20, 0x10, 0xff]);
  });

  it('honours a padded row pitch instead of shearing the image', () => {
    const pixels = [
      [1, 2, 3, 4],
      [5, 6, 7, 8],
    ];
    // One pixel per row, with room for two — a decoder that assumed tight rows
    // would read row 2's first pixel out of row 1's padding.
    const { rgba } = decodeTex(makeTex(1, 2, [pixels[0]!, pixels[1]!], { pitch: 8 }));
    expect([...rgba.subarray(0, 4)]).toEqual([3, 2, 1, 4]);
    expect([...rgba.subarray(4, 8)]).toEqual([7, 6, 5, 8]);
  });

  it('reports a compressed texture as unsupported rather than as corrupt', () => {
    const tex = makeTex(4, 4, [], { fourCC: 'DXT5' });
    expect(() => decodeTex(tex)).toThrow(UnsupportedTextureError);
    expect(() => decodeTex(tex)).toThrow(/DXT5/);
  });

  it('rejects a file that is not a .tex', () => {
    expect(() => decodeTex(Buffer.from('PNG\r\n\x1a\n........'))).toThrow(/not a \.tex/);
  });

  it('rejects a texture that carries less than its wrapper declares', () => {
    const tex = makeTex(4, 4, []);
    expect(() => decodeTex(tex.subarray(0, tex.length - 8))).toThrow(/declares 192 bytes of DDS but carries 184/);
  });

  it('rejects a texture with less pixel data than its dimensions need', () => {
    // Consistent wrapper, short image — the case a length check on the wrapper
    // alone would wave through and then read past the end of.
    const tex = makeTex(4, 4, []).subarray(0, 12 + 160);
    tex.writeUInt32LE(160, 8);
    expect(() => decodeTex(tex)).toThrow(/too short for 4×4/);
  });
});

describe('PNG encoding', () => {
  it('writes a decodable 8-bit RGBA PNG', () => {
    const rgba = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
    const png = encodePng(2, 2, rgba);

    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(png.toString('latin1', 12, 16)).toBe('IHDR');
    expect(png.readUInt32BE(16)).toBe(2); // width
    expect(png.readUInt32BE(20)).toBe(2); // height
    expect(png[24]).toBe(8); // bit depth
    expect(png[25]).toBe(6); // colour type: RGBA
    expect(png.toString('latin1', png.length - 8, png.length - 4)).toBe('IEND');

    // Round-trip the pixel data: each scanline is a filter byte then the row.
    const idatStart = png.indexOf('IDAT', 0, 'latin1') + 4;
    const idatLength = png.readUInt32BE(idatStart - 8);
    const raw = inflateSync(png.subarray(idatStart, idatStart + idatLength));
    expect([...raw]).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 0, 9, 10, 11, 12, 13, 14, 15, 16]);
  });

  it('refuses pixel data that does not match the dimensions', () => {
    expect(() => encodePng(2, 2, Buffer.alloc(8))).toThrow(/expected 16 bytes/);
  });
});

describe('icon cache names', () => {
  it('flattens a texture path into one PNG filename', () => {
    expect(flatten('items/enchants/enchantm_black.tex')).toBe('items_enchants_enchantm_black.png');
  });

  it('leaves no separator a record path could escape the cache directory with', () => {
    expect(flatten('items/../../etc/passwd.tex')).not.toMatch(/[/\\]/);
  });
});

describe('.arc reading', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'gd-arc-'));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('rejects a file that is not an archive', () => {
    const path = join(dir, 'not.arc');
    writeFileSync(path, Buffer.alloc(64));
    expect(() => ArcArchive.open(path)).toThrow(/not an \.arc archive/);
  });

  it('rejects an unsupported archive version', () => {
    const path = join(dir, 'v9.arc');
    const buf = Buffer.alloc(64);
    buf.write('ARC\0', 0, 'latin1');
    buf.writeUInt32LE(9, 4);
    writeFileSync(path, buf);
    expect(() => ArcArchive.open(path)).toThrow(/unsupported \.arc version 9/);
  });

  it('reports a truncated archive instead of reading garbage offsets', () => {
    const path = join(dir, 'short.arc');
    const buf = Buffer.alloc(64);
    buf.write('ARC\0', 0, 'latin1');
    buf.writeUInt32LE(3, 4);
    buf.writeUInt32LE(10, 8); // 10 file entries the file has no room for
    buf.writeUInt32LE(28, 24);
    writeFileSync(path, buf);
    expect(() => ArcArchive.open(path)).toThrow(/tables end at/);
  });
});

// ---------------------------------------------------------------------------
// The real archives — needs the game installed
// ---------------------------------------------------------------------------

describe.skipIf(!haveGameInstall())(`game icons (${haveGameInstall() ? 'live' : MISSING_GAME_MESSAGE})`, () => {
  const BUILD_TIMEOUT = 180_000;
  /** A throwaway cache, so the "already extracted?" assertions start from cold. */
  let dataDir: string;
  const realDataDir = process.env['GD_DATA_DIR'];

  const restoreDataDir = (): void => {
    if (realDataDir === undefined) delete process.env['GD_DATA_DIR'];
    else process.env['GD_DATA_DIR'] = realDataDir;
  };

  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'gd-icons-'));
  });
  // Restored after every test, not just at the end: the *database* cache lives
  // under the same directory, and leaving it pointed at a temp dir would make
  // the next test re-download the localization table.
  afterEach(restoreDataDir);
  afterAll(() => {
    rmSync(dataDir, { recursive: true, force: true });
    restoreDataDir();
  });

  it('extracts a known texture straight out of Items.arc', () => {
    const archive = ArcArchive.open(join(findGameDir()!, 'resources/Items.arc'));
    try {
      const tex = archive.read('enchants/enchantm_black.tex');
      expect(tex).toBeDefined();
      // Case-insensitive, because the records and the archive disagree on it.
      expect(archive.read('Enchants/EnchantM_Black.tex')).toEqual(tex);
      expect(archive.read('enchants/no_such_texture.tex')).toBeUndefined();

      const { width, height } = decodeTex(tex!);
      expect([width, height]).toEqual([32, 64]);
    } finally {
      archive.close();
    }
  });

  describe('icon service', () => {
    const realFetch = globalThis.fetch;
    afterEach(() => {
      globalThis.fetch = realFetch;
    });

    it('writes a PNG on the first request and reuses it on the second', async () => {
      process.env['GD_DATA_DIR'] = dataDir;
      // Icons come out of the install; nothing here may reach for the network.
      globalThis.fetch = (() => {
        throw new Error('icons must never hit the network');
      }) as typeof fetch;

      const first = createIconService();
      let path: string | undefined;
      try {
        path = await first.getIconPng('items/enchants/enchantm_black.tex');
        expect(path).toBeDefined();
        expect(existsSync(path!)).toBe(true);
        expect(first.stats()).toMatchObject({ decoded: 1, cached: 0, missing: 0, failed: 0 });

        const png = readFileSync(path!);
        expect([...png.subarray(1, 4)]).toEqual([0x50, 0x4e, 0x47]);
        expect(png.readUInt32BE(16)).toBe(32);
        expect(png.readUInt32BE(20)).toBe(64);
      } finally {
        first.close();
      }

      // A second service over the same cache must not re-extract anything.
      const second = createIconService();
      try {
        expect(await second.getIconPng('items/enchants/enchantm_black.tex')).toBe(path);
        expect(second.stats()).toMatchObject({ decoded: 0, cached: 1 });
      } finally {
        second.close();
      }
    });

    it('answers undefined, with a reason, for art the archives do not have', async () => {
      process.env['GD_DATA_DIR'] = dataDir;
      const icons = createIconService();
      try {
        expect(await icons.getIconPng('items/nowhere/not_a_real_icon.tex')).toBeUndefined();
        expect(await icons.getIconPng('')).toBeUndefined();
        expect(icons.stats().missing).toBe(2);
        expect(icons.problems().get('items/nowhere/not_a_real_icon.tex')).toMatch(/no items\.arc contains/i);
      } finally {
        icons.close();
      }
    });
  });

  describe.skipIf(!haveSaves())(`equipped gear (${haveSaves() ? 'live saves' : MISSING_SAVES_MESSAGE})`, () => {
    it('finds an icon for every equipped item both characters wear', { timeout: BUILD_TIMEOUT }, async () => {
      const db = await gameDb();
      process.env['GD_DATA_DIR'] = dataDir;
      const icons = createIconService();
      try {
        const missing: string[] = [];
        for (const name of CHARACTERS) {
          const path = characterSavePath(name);
          const character = resolveCharacter(parseGdc(readFileSync(path), { path }), undefined, undefined, db);
          const equipped = character.items.filter((i) => i.source === 'equipped');
          expect(equipped.length).toBeGreaterThan(0);

          for (const item of equipped) {
            for (const part of [item.base, item.component, item.augment]) {
              if (!part?.iconPath) continue;
              if (!(await icons.getIconPng(part.iconPath))) missing.push(`${part.name} (${part.iconPath})`);
            }
          }
        }
        expect(missing).toEqual([]);
      } finally {
        icons.close();
      }
    });
  });
});
