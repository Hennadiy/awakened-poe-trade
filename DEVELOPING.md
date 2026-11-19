# How this works

There are 2 main parts of the app:

1. renderer: this is the HTML/Javascript-based UI rendered within the Electron container. This runs Vue.js, a React-like Javascript framework for rendering front-end.
2. main: includes the main app (written in Electron). Handles keyboard shortcuts, brings up the UI and overlays.

Note that these 2 both depend on each other, and one cannot run without the other.

# How to develop

The most up-to-date instructions can always be derived from CI:

[.github/workflows/main.yml](https://github.com/SnosMe/awakened-poe-trade/blob/master/.github/workflows/main.yml)

Here's what that looks like as of 2026-08-01.

```shell
cd renderer
npm ci
npm run dev

# In a second shell
cd main
npm ci
npm run dev
```

On a fresh clone the first `npm run dev` in `renderer` generates the
`public/data/**/*.index.bin` files after Vite has started, and the app fails to
load item data. Restart the renderer dev server once and it works.

# Local install (Windows)

```shell
cd main
npm run install-local
```

Builds the app and installs it into `%LOCALAPPDATA%\Programs\Awakened PoE Trade`
(over the official install, so its Start menu shortcut opens this build), registers it
to start with Windows, and starts it. It also installs a git `post-commit` hook: every
commit on the `dio-ver` branch rebuilds and reinstalls in the background
(log: `main/dist/local-install.log`).

To update, run **Update Awakened PoE Trade** from the Start menu (or double-click
`update-app.cmd`, or `npm run update-local` in `main`). It pulls the latest `dio-ver`
from GitHub (fast-forward only), runs `npm ci` where `package-lock.json` changed, then
rebuilds, reinstalls and restarts the app. With nothing new to pull it just reinstalls.

`npm run dev` in `main` closes the installed app first (they share hotkeys, config and
the single-instance lock) and starts it again when dev is stopped with Ctrl-C.
A reinstall that happens while dev is running doesn't start the installed app.

# Adding new league items

When a league adds items the app doesn't recognize, pull them from the trade site.
GGG asks API clients to send a User-Agent that identifies them, so set one first:

```shell
cd renderer
export POE_TRADE_USER_AGENT="OAuth <app-name>/<version> (contact: <your email>)"
# PowerShell: $env:POE_TRADE_USER_AGENT = "OAuth <app-name>/<version> (contact: <your email>)"
npm run sync-trade-data -- --dry                      # list what's missing
npm run sync-trade-data                               # add it
npm run sync-trade-data -- --icons --league "Covens"  # add it, with icons for new bases
```

The trade site bans IPs that flood it. A normal run sends 3 requests; `--icons`
adds a few more, spaced 5s apart. The script stops on the first rate-limit reply.
Run it once per league, not in a loop. Responses are saved to `renderer/.trade-data`;
add `--offline` to rerun from them without asking the site again.

It appends bulk-exchange items (currency, fragments, cards), base types of the
item groups listed in `BASE_GROUPS` and unique items (except unique maps) to
`public/data/en/items.ndjson`. In `public/data/en/stats.ndjson` it adds the trade
site's wording of reworded modifiers (e.g. "+#% to Item Rarity"), keeping the old
wording, and adds modifiers the app has no stat for (new uniques, league mods).
New uniques get no icon. A brand new
item group (like Viscera) also needs an `ItemCategory` and a trade category mapping,
see `src/parser/meta.ts` and `src/web/price-check/trade/pathofexile-trade.ts`.

# How to build

```shell
cd renderer
npm ci
npm run build

cd ../main
npm ci
npm run build
# We want to sign with a distribution certificate to ensure other users can
# install without errors
CSC_NAME="Certificate name in Keychain" npm run package
```
