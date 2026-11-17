// @ts-check
// Adds items and modifier texts that the official trade site knows about but
// public/data/en/{items,stats}.ndjson do not.
//
//   npm run sync-trade-data -- [--dry] [--icons] [--league <name>] [--offline]
//
// Requires POE_TRADE_USER_AGENT, e.g. "OAuth <app-name>/<version> (contact: <your email>)".
//
// The trade site rate-limits and bans IPs that flood it. A normal run sends 3 requests
// and saves the responses to renderer/.trade-data; --offline reuses them instead of
// asking the site again (no User-Agent needed).
// --icons adds 1 search + up to 5 fetches per new item group, 5s apart. Any 429 stops
// the script without retrying. Don't run it in a loop.
//
// 1. Bulk exchange items (/api/trade/data/static): currency, fragments, cards, ...
//    Added as ITEM with a tradeTag, or DIVINATION_CARD for cards.
// 2. Base types of the trade item groups listed in BASE_GROUPS (/api/trade/data/items).
//    Added as ITEM with craftable.category. With --icons, icons come from one trade
//    search in --league, so only bases that currently have listings get one.
//
// 3. Reworded modifiers (/api/trade/data/stats). When a league changes a modifier's
//    wording (e.g. "#% increased Rarity of Items found" -> "+#% to Item Rarity"), the
//    trade site's new text is added as one more matcher of the stat with that trade id.
//    Old wordings stay, so items from before the change still parse. Brand new modifiers
//    are not added.
//
// Names and texts that already exist are skipped, so the script is safe to rerun.
// Only English data is updated. Vite regenerates the *.index.bin files on change.

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

/** trade item group id -> ItemCategory value (see src/parser/meta.ts) */
const BASE_GROUPS = {
  viscera: 'Viscera'
}

/** static groups that are not real items (search helpers) */
const SKIP_STATIC_GROUPS = new Set(['MapKey', 'MapsSpecial', 'MapsUnique', 'Heist'])

const args = process.argv.slice(2)
const DRY = args.includes('--dry')
const ICONS = args.includes('--icons')
const OFFLINE = args.includes('--offline')
const LEAGUE = args.includes('--league') ? args[args.indexOf('--league') + 1] : 'Standard'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ITEMS_FILE = path.join(__dirname, '../public/data/en/items.ndjson')
const STATS_FILE = path.join(__dirname, '../public/data/en/stats.ndjson')
const CACHE_DIR = path.join(__dirname, '../.trade-data')

const USER_AGENT = process.env.POE_TRADE_USER_AGENT
if (!USER_AGENT && (!OFFLINE || ICONS)) {
  console.error(
    'Set POE_TRADE_USER_AGENT to a User-Agent that identifies you, as GGG asks of API clients, e.g.\n' +
    '  OAuth <app-name>/<version> (contact: <your email>)'
  )
  process.exit(1)
}

const API = 'https://www.pathofexile.com/api/trade'
const HEADERS = {
  'User-Agent': USER_AGENT ?? '',
  'Content-Type': 'application/json'
}
const ICON_HOST = 'https://web.poecdn.com'

const sleep = (/** @type {number} */ ms) => new Promise(resolve => setTimeout(resolve, ms))

async function getJson (/** @type {string} */ url, /** @type {RequestInit} */ init = {}) {
  const res = await fetch(url, { headers: HEADERS, ...init })
  if (res.status === 429) {
    // never retry: repeated requests while limited can get the IP banned
    throw new Error(`Rate limited by the trade site, retry after ${res.headers.get('retry-after') ?? '?'}s. Stopping. — ${url}`)
  }
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} — ${url}`)
  return await res.json()
}

/** GET /api/trade/data/<name>, or its saved copy with --offline */
async function getData (/** @type {string} */ name) {
  const file = path.join(CACHE_DIR, `${name}.json`)
  if (OFFLINE) {
    if (!fs.existsSync(file)) throw new Error(`--offline: ${file} not found, run once without --offline`)
    return JSON.parse(fs.readFileSync(file, 'utf-8'))
  }
  const data = await getJson(`${API}/data/${name}`)
  fs.mkdirSync(CACHE_DIR, { recursive: true })
  fs.writeFileSync(file, JSON.stringify(data))
  return data
}

const text = fs.readFileSync(ITEMS_FILE, 'utf-8')
const eol = text.includes('\r\n') ? '\r\n' : '\n'
const existing = text.split('\n').filter(line => line.trim()).map(line => JSON.parse(line))
const knownNames = new Set(existing.map(item => item.name))
const knownTags = new Set(existing.filter(item => item.tradeTag).map(item => item.tradeTag))

/** @type {object[]} */
const toAdd = []
/** @type {string[]} */
const report = []

function add (/** @type {any} */ entry, /** @type {string} */ group) {
  toAdd.push(entry)
  knownNames.add(entry.name)
  report.push(`${group}: ${entry.name}`)
}

// 1. bulk exchange items
const staticData = await getData('static')
for (const group of staticData.result) {
  if (SKIP_STATIC_GROUPS.has(group.id)) continue
  for (const entry of group.entries) {
    if (entry.id === 'sep' || !entry.text || /\((Level|Tier) /.test(entry.text)) continue
    if (knownTags.has(entry.id) || knownNames.has(entry.text)) continue

    const isCard = (group.id === 'Cards')
    add({
      name: entry.text,
      refName: entry.text,
      namespace: isCard ? 'DIVINATION_CARD' : 'ITEM',
      ...(isCard ? {} : { tradeTag: entry.id }),
      exchangeable: true,
      icon: entry.image ? ICON_HOST + entry.image : ''
    }, group.id)
  }
}

// 2. base types of selected item groups
const itemsData = await getData('items')
for (const [groupId, category] of Object.entries(BASE_GROUPS)) {
  const group = itemsData.result.find((/** @type {any} */ g) => g.id === groupId)
  if (!group) {
    console.warn(`Trade item group "${groupId}" not found, skipping.`)
    continue
  }
  const types = [...new Set(group.entries.filter((/** @type {any} */ e) => !e.name).map((/** @type {any} */ e) => e.type))]
    .filter(type => !knownNames.has(type))
  if (!types.length) continue

  const icons = (ICONS && !DRY) ? await iconsFromSearch(groupId) : new Map()
  for (const type of types) {
    const icon = icons.get(type)
    add({
      name: type,
      refName: type,
      namespace: 'ITEM',
      craftable: { category },
      icon: icon?.icon ?? '',
      ...(icon?.w > 1 ? { w: icon.w } : {}),
      ...(icon?.h > 1 ? { h: icon.h } : {})
    }, groupId)
  }
}

async function iconsFromSearch (/** @type {string} */ category) {
  /** @type {Map<string, { icon: string, w: number, h: number }>} */
  const icons = new Map()
  try {
    const search = await getJson(`${API}/search/${encodeURIComponent(LEAGUE)}`, {
      method: 'POST',
      body: JSON.stringify({
        query: { status: { option: 'any' }, filters: { type_filters: { filters: { category: { option: category } } } } },
        sort: { price: 'asc' }
      })
    })
    const ids = search.result.slice(0, 50)
    for (let i = 0; i < ids.length; i += 10) {
      await sleep(5000) // stay far below the fetch rate limit
      const page = await getJson(`${API}/fetch/${ids.slice(i, i + 10).join(',')}?query=${search.id}`)
      for (const r of page.result) {
        if (r?.item) icons.set(r.item.baseType, { icon: r.item.icon, w: r.item.w, h: r.item.h })
      }
    }
  } catch (e) {
    console.warn(`Could not fetch icons for "${category}": ${e}`)
  }
  return icons
}

// 3. reworded modifiers
const statsText = fs.readFileSync(STATS_FILE, 'utf-8')
const statsEol = statsText.includes('\r\n') ? '\r\n' : '\n'
const statLines = statsText.split(/\r?\n/)
/** one entry per line: a stat, or a group of stats that share a matcher */
const statEntries = statLines.map(line => line.trim() ? JSON.parse(line) : null)
/** @type {Map<string, Array<{ stat: any, line: number }>>} */
const statsByTradeId = new Map()
/** matcher text -> line it is on */
const knownMatchers = new Map()
statEntries.forEach((entry, line) => {
  for (const stat of (entry?.stats ?? (entry ? [entry] : []))) {
    for (const m of stat.matchers ?? []) {
      knownMatchers.set(m.string, line)
      if (m.advanced) knownMatchers.set(m.advanced, line)
    }
    for (const ids of Object.values(stat.trade?.ids ?? {})) {
      for (const id of /** @type {string[]} */ (ids)) {
        const list = statsByTradeId.get(id) ?? []
        if (!list.some(s => s.stat === stat)) list.push({ stat, line })
        statsByTradeId.set(id, list)
      }
    }
  }
})

const statsData = await getData('stats')
/** @type {Set<number>} */
const changedLines = new Set()
/** @type {string[]} */
const statReport = []
for (const group of statsData.result) {
  for (const entry of group.entries) {
    if (entry.option || entry.id.startsWith('pseudo.')) continue
    // "(Local)", "(Shields)", ... are trade site annotations, not part of the in-game text
    if (/ \([^)]*\)$/.test(entry.text)) continue
    // the parser turns signed rolls ("+16") into "#"
    const matcher = entry.text.replace(/[+-]#/g, '#')
    const targets = statsByTradeId.get(entry.id)
    // unknown or ambiguous trade id: no way to tell which stat the text belongs to
    if (!targets || targets.length !== 1) continue
    const { stat, line } = targets[0]
    if (stat.matchers.some((/** @type {any} */ m) => m.string === matcher || m.advanced === matcher)) continue
    // a text may live on one line only (the parser indexes stats by matcher text)
    if (knownMatchers.has(matcher) && knownMatchers.get(matcher) !== line) continue
    // a shorter text of a multi-line modifier would match only its first line
    const lineCount = matcher.split('\n').length
    if (stat.matchers.some((/** @type {any} */ m) => m.string.split('\n').length > lineCount)) continue

    // Stats grouped on one line share their wording (local/global variants, several trade
    // ids), and the parser only resolves a group member that has the matched text.
    const siblings = (statEntries[line].stats ?? [statEntries[line]]).filter((/** @type {any} */ s) =>
      s === stat || s.matchers.some((/** @type {any} */ m) => stat.matchers.some((/** @type {any} */ n) => n.string === m.string)))
    for (const s of siblings) {
      if (!s.matchers.some((/** @type {any} */ m) => m.string === matcher)) s.matchers.push({ string: matcher })
    }
    knownMatchers.set(matcher, line)
    changedLines.add(line)
    statReport.push(`${JSON.stringify(stat.ref)} -> ${JSON.stringify(matcher)}`)
  }
}

console.log(report.join('\n'))
console.log(`\n${toAdd.length} item(s) ${DRY ? 'would be added' : 'added'} to ${path.relative(process.cwd(), ITEMS_FILE)}`)
if (!DRY && toAdd.length) {
  fs.appendFileSync(ITEMS_FILE, toAdd.map(entry => JSON.stringify(entry)).join(eol) + eol)
}

console.log('\n' + statReport.join('\n'))
console.log(`\n${statReport.length} modifier text(s) ${DRY ? 'would be added' : 'added'} to ${path.relative(process.cwd(), STATS_FILE)}`)
if (!DRY && changedLines.size) {
  for (const line of changedLines) statLines[line] = JSON.stringify(statEntries[line])
  fs.writeFileSync(STATS_FILE, statLines.join(statsEol))
}
