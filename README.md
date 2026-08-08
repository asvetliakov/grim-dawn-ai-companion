# Grim Dawn Companion

A macOS-native desktop companion for [Grim Dawn](https://www.grimdawn.com/). The
game runs under CrossOver; this tool runs natively alongside it. It reads your
character saves, resolves every item against the game's own database, and — on
demand — asks an AI for equip/replace/hold advice.

Development is staged; see [RUNBOOK.md](RUNBOOK.md) for what is built and what is next.

## Running it

```bash
npm install
npm run cli -- db --stats             # build/inspect the item database
npm run cli -- resolve --char <name>  # resolve a character's gear
npm run cli -- icon --check-all       # extract icons for everything you own
npm test                              # vitest
npm run typecheck
```

The tool finds your Grim Dawn install and save directory automatically. Override
either with `GD_GAME_DIR` / `GD_SAVE_DIR`, or pin them in
`~/Library/Application Support/gd-companion/settings.json`.

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
`~/Library/Application Support/gd-companion/cache/<build>/`, keyed by a
fingerprint of the archives, so a game patch re-derives it exactly once.

Set `locale` in `settings.json` to any language the install ships —
`npm run cli -- db --stats` lists them.

**No game-derived data is committed to this repository**: no archive contents, no
extracted assets, no save files. The repo ships code only.
