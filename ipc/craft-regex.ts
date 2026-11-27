// Stop pattern for the craft click key, written like the game's stash search
// (what poe.re and similar sites generate):
//   terms separated by spaces must all match,  "quoted terms" may contain spaces,
//   a term starting with ! must not match,  | inside a term means "or".
// Each term is a case-insensitive regular expression.

export interface CraftMatcher {
  test: (itemText: string) => boolean
}

export function createCraftMatcher (pattern: string): CraftMatcher | Error | null {
  const terms: Array<{ re: RegExp, negate: boolean }> = []
  for (const m of pattern.matchAll(/(!?)"([^"]*)"?|(\S+)/g)) {
    let body = m[2] ?? m[3]
    let negate = m[1] === '!'
    if (body.startsWith('!')) {
      negate = true
      body = body.slice(1)
    }
    if (!body) continue
    try {
      terms.push({ re: new RegExp(body, 'i'), negate })
    } catch (e) {
      return new Error(`${body}: ${(e as Error).message}`)
    }
  }
  if (!terms.length) return null

  return {
    test (itemText) {
      const text = searchableText(itemText)
      return terms.every(({ re, negate }) => re.test(text) !== negate)
    }
  }
}

// Copied item text, as the game's search sees it:
// no "{ Prefix Modifier ... }" lines, no roll ranges like "30(25-35)%"
export function searchableText (itemText: string): string {
  return itemText
    .split(/\r?\n/)
    .filter(line => !line.startsWith('{') && line !== '--------')
    .map(line => line
      .replace(/(?<=\d)\([^()]*\)/g, '')
      .replace(/\(\.\.\.\)/g, '')
      .replace(/ — Unscalable Value$/, ''))
    .join('\n')
}
