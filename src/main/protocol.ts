/**
 * `gdicon://` — the renderer's only way to see a pixel from the game.
 *
 * One namespace serves item icons and window chrome: both are arc-relative
 * `.tex` paths, the archive is named by the first segment, and `getIconPng`
 * already resolves that. The handler is therefore a cache lookup with a decode
 * behind it, not a second asset pipeline.
 *
 * The `immutable` cache header is honest rather than optimistic: the PNG cache
 * directory is keyed on a fingerprint of the installed archives, so a game
 * patch produces different URLs' worth of files in a different directory.
 */

import { readFile } from 'node:fs/promises';
import { protocol, type Session } from 'electron';

import type { IconService } from '@grimdawn/core/icons';

export const GDICON_SCHEME = 'gdicon';

/**
 * Must run before `app.whenReady()`. `stream`/`supportFetchAPI` are what let a
 * page load these as ordinary images and CSS backgrounds under a CSP that
 * allows the scheme.
 */
export function registerIconScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: GDICON_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
    },
  ]);
}

function notFound(reason: string): Response {
  return new Response(reason, { status: 404, headers: { 'Content-Type': 'text/plain' } });
}

/**
 * `gdicon://tex/items/enchants/enchantm_black.tex` → the cached PNG.
 *
 * `iconsFor` is asked per request rather than captured, because the service is
 * dropped and rebuilt whenever the game directory changes and a stale handle
 * would keep serving art from the old install.
 */
export function handleIconProtocol(session: Session, iconsFor: () => Promise<IconService | undefined>): void {
  session.protocol.handle(GDICON_SCHEME, async (request) => {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return notFound('malformed gdicon URL');
    }
    if (url.hostname !== 'tex') return notFound(`unknown gdicon namespace ${url.hostname}`);

    const texPath = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    // Defence in depth. `flatten()` already collapses separators, which makes a
    // path that escapes the cache directory unrepresentable — but a rejected
    // traversal attempt should never depend on a detail two modules away.
    if (!texPath || texPath.split('/').includes('..')) return notFound('bad texture path');

    const icons = await iconsFor();
    if (!icons) return notFound('no game directory');

    const png = await icons.getIconPng(texPath);
    if (!png) return notFound(`no texture ${texPath}`);

    try {
      return new Response(await readFile(png), {
        headers: {
          'Content-Type': 'image/png',
          'Cache-Control': 'public, max-age=31536000, immutable',
        },
      });
    } catch (err) {
      return notFound((err as Error).message);
    }
  });
}
