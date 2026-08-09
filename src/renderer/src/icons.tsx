/**
 * Where an item's art comes from.
 *
 * In the app it is `gdicon://`, served by the main process out of the game's
 * archives. In Storybook there is no main process, so the stories inject a
 * resolver that draws a stand-in instead — which is the only reason the whole
 * UI can be developed and screenshotted without launching Electron.
 */

import { createContext, useContext, type ReactNode } from 'react';

import { gdiconUrl } from '../../shared/ipc.js';

export type IconResolver = (texPath: string) => string;

const IconContext = createContext<IconResolver>(gdiconUrl);

export function useIconUrl(): IconResolver {
  return useContext(IconContext);
}

export function IconUrlProvider({
  resolve,
  children,
}: {
  resolve: IconResolver;
  children: ReactNode;
}): ReactNode {
  return <IconContext.Provider value={resolve}>{children}</IconContext.Provider>;
}
