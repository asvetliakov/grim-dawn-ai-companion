# Grim Dawn AI Companion

A desktop companion for [Grim Dawn](https://www.grimdawn.com/). It reads your
character saves, resolves every item against the game's own database, and — on
demand — asks an AI for equip/replace/hold advice. It watches the save folder, so
alt-tabbing back from the game shows what you are wearing now.

Built on macOS, where the game runs under CrossOver and the tool runs natively
beside it. It is not macOS-only: Grim Dawn is a Windows game whatever it is
wrapped in, so the install and the saves are found the same way everywhere.

Development is staged; see [RUNBOOK.md](RUNBOOK.md) for what is built and what is next.

## Running it

```bash
npm install
npm run dev                           # the window
npm run cli -- paths                  # where it thinks the game and saves are
npm run cli -- watch                  # print what the game writes, live
npm run cli -- db --stats             # build/inspect the item database
npm run cli -- resolve --char <name>  # resolve a character's gear
npm test                              # vitest
npm run typecheck
```

## Finding your game

Both stores, all three platforms, all found without being told:

| | Install | Saves |
|---|---|---|
| **Steam** | `steamapps/common/Grim Dawn`, including libraries on other drives (`libraryfolders.vdf`) | `userdata/<id>/219990/remote/save` with cloud saves on |
| **GOG** | `GOG Games/Grim Dawn`, GOG Galaxy's games folder, `Games/Grim Dawn` | `Documents/My Games/Grim Dawn/save` |

On macOS those are looked for inside every CrossOver and Whisky bottle; on Linux,
in a Wine prefix and in Steam's Proton prefix for this app id; on Windows, across
every drive letter, and in OneDrive's redirected `Documents` as well as the plain
one. Cloud-off Steam uses the GOG location too.

If yours is somewhere nobody could guess, **Settings** takes a typed path for
either — or set `GD_GAME_DIR` / `GD_SAVE_DIR`, or pin `gameDir` / `saveDir` in
`~/Library/Application Support/gd-ai-companion/settings.json`.

## Building a release

```bash
npm run dist       # macOS (arm64): .dmg and .zip in release/
npm run dist:win   # Windows (x64): a portable .zip — cross-builds from macOS
npm run dist:all   # both
```

The Windows build works from a Mac because there is nothing to compile: the
zero-dependency rule means no native modules, so packaging is Electron's own
prebuilt binaries plus this app's JavaScript. The Windows target is a **zip**
rather than an NSIS installer for the same reason it works at all — an installer
would need Wine to build here, and a portable zip has no install step.

Neither build is signed or notarized (there is no certificate in this repo, and
there should not be), so macOS wants a right-click → Open the first time and
Windows will show a SmartScreen warning. Fine for a personal tool; a public
release needs certificates, not a config change.

## Where the data comes from

**Your Grim Dawn install, and nothing else.** The tool makes no network requests
at all, so it works offline and always describes the build you actually have:

| What | Where it is read from |
|---|---|
| Item identity, stats, vendor stock | `database/*.arz` — the only place a save's DBR record paths can be looked up |
| Item and skill **names** | `resources/Text_<LOCALE>.arc` (20,322 tags; 13 languages ship with the game) |
| Item **icons** | `resources/Items.arc` — one texture per icon, decoded to PNG on first use |
| Game version | the build string in `Engine.dll` |

The base game and each expansion contribute their own archives, merged in load
order so an expansion's changes win. Everything derived is cached under
`~/Library/Application Support/gd-ai-companion/cache/<build>/`, keyed by a
fingerprint of the archives, so a game patch re-derives it exactly once.

Set `locale` in `settings.json` to any language the install ships —
`npm run cli -- db --stats` lists them.

**No game-derived data is committed to this repository**: no archive contents, no
extracted assets, no save files. The repo ships code only.
