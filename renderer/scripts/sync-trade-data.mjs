// @ts-check
// Adds items that the official trade site knows about but public/data/en/items.ndjson does not.
//
//   npm run sync-trade-data -- [--dry] [--icons] [--league <name>]
//
// Requires POE_TRADE_USER_AGENT, e.g. "OAuth <app-name>/<version> (contact: <your email>)".
//
// The trade site rate-limits and bans IPs that flood it. A normal run sends 2 requests.
// --icons adds 1 search + up to 5 fetches per new item group, 5s apart. Any 429 stops
// the script without retrying. Don't run it in a loop.
//
// 1. Bulk exchange items (/api/trade/data/static): currency, fragments, cards, ...
//    Added as ITEM with a tradeTag, or DIVINATION_CARD for cards.
// 2. Base types of the trade item groups listed in BASE_GROUPS (/api/trade/data/items).
//    Added as ITEM with craftable.category. With --icons, icons come from one trade
//    search in --league, so only bases that currently have listings get one.
//
// Names that already exist in any namespace are skipped, so the script is safe to rerun.
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

const USER_AGENT = process.env.POE_TRADE_USER_AGENT
if (!USER_AGENT) {
  console.error(
    'Set POE_TRADE_USER_AGENT to a User-Agent that identifies you, as GGG asks of API clients, e.g.\n' +
    '  OAuth <app-name>/<version> (contact: <your email>)'
  )
  process.exit(1)
}

const API = 'https://www.pathofexile.com/api/trade'
const HEADERS = {
  'User-Agent': USER_AGENT,
  'Content-Type': 'application/json'
}
const ICON_HOST = 'https://web.poecdn.com'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FILE = path.join(__dirname, '../public/data/en/items.ndjson')

const args = process.argv.slice(2)
const DRY = args.includes('--dry')
const ICONS = args.includes('--icons')
const LEAGUE = args.includes('--league') ? args[args.indexOf('--league') + 1] : 'Standard'

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

const text = fs.readFileSync(FILE, 'utf-8')
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
const staticData = await getJson(`${API}/data/static`)
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
const itemsData = await getJson(`${API}/data/items`)
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

console.log(report.join('\n'))
console.log(`\n${toAdd.length} item(s) ${DRY ? 'would be added' : 'added'} to ${path.relative(process.cwd(), FILE)}`)
if (!DRY && toAdd.length) {
  fs.appendFileSync(FILE, toAdd.map(entry => JSON.stringify(entry)).join(eol) + eol)
}
