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
npm test                              # vitest
npm run typecheck
```

The tool finds your Grim Dawn install and save directory automatically. Override
either with `GD_GAME_DIR` / `GD_SAVE_DIR`, or pin them in
`~/Library/Application Support/gd-companion/settings.json`.

## Where the data comes from

Item identity lives in the game's own `database/*.arz` archives, which are the
only place a save's DBR record paths can be looked up. Those archives are read
from your local install and cached, normalized, under
`~/Library/Application Support/gd-companion/cache/`. The game version is read
from `Engine.dll`.

Item and skill **names** come from the localization table published by
**[GrimTools](https://www.grimtools.com/) (Dammitt)** — thank you. That one ~1 MB
file is the only thing fetched over the network, at most once per game version,
and it is cached locally.

**No game-derived data is committed to this repository**: no archive contents, no
GrimTools downloads, no save files. The repo ships code only.
