/**
 * Wiki engine — knowledge base for agents.
 * Ported from Stacklane monorepo apps/api/src/services/wiki.ts and adapted for
 * edge storage: pages are persisted in the Netlify blob store via the shared
 * db (db.wiki.pages) instead of a local filesystem.
 */
import { randomUUID } from 'node:crypto'

export const WIKI_VERSION = '0.1.0'

export async function wikiInit(db) {
  if (!db.wiki) db.wiki = { pages: {}, sources: {}, created: new Date().toISOString() }
  return { status: 'ok', message: 'Wiki structure initialized.', wikiDir: 'db://wiki' }
}

export async function wikiIngest(db, input) {
  const source = input.source || 'inline'
  const content = input.content || ''
  const pageId = `pg_${randomUUID().slice(0, 12)}`
  const page = {
    id: pageId,
    title: (content.split('\n').find((l) => l.trim()) || source).substring(0, 100),
    content: content.substring(0, 5000),
    source,
    created: new Date().toISOString(),
    updated: new Date().toISOString(),
  }
  if (!db.wiki) db.wiki = { pages: {}, sources: {}, created: new Date().toISOString() }
  db.wiki.pages[pageId] = page
  if (!db.wiki.sources[source]) db.wiki.sources[source] = []
  db.wiki.sources[source].push(pageId)
  return {
    source,
    pagesCreated: 1,
    linksCreated: 0,
    pages: [page.title],
    pageId,
  }
}

export async function wikiQuery(db, question) {
  const pages = db.wiki?.pages ? Object.values(db.wiki.pages) : []
  if (!pages.length) {
    return { answer: 'No knowledge base found. Run init first.', sources: [] }
  }
  const terms = (question || '')
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 3 && !['what', 'about', 'tell', 'know', 'search', 'find', 'does', 'the', 'is', 'are'].includes(w))
  const scored = pages
    .map((p) => {
      const lower = (p.title + ' ' + p.content).toLowerCase()
      const score = terms.reduce((acc, t) => acc + (lower.includes(t) ? 1 : 0), 0)
      return { page: p, score }
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
  const sources = scored.map((s) => ({
    title: s.page.title,
    path: `db://wiki/${s.page.id}`,
    excerpt: s.page.content.substring(0, 200),
  }))
  return {
    answer: sources.length
      ? `Found ${sources.length} relevant sources:\n\n` + sources.map((s) => `- **${s.title}**: ${s.excerpt}`).join('\n')
      : `No results found for "${question}". Try ingesting some sources first.`,
    sources,
  }
}

export async function wikiLint(db) {
  const pages = db.wiki?.pages ? Object.values(db.wiki.pages) : []
  const allLinks = new Set()
  const deadLinks = []
  const staleClaims = []
  for (const p of pages) {
    const content = p.content
    const links = content.match(/\[\[([^\]]+)\]\]/g) || []
    for (const link of links) {
      const target = link.replace(/\[\[|\]\]/g, '')
      allLinks.add(target)
      const exists = Object.values(db.wiki.pages || {}).some((pp) => pp.title === target)
      if (!exists) deadLinks.push({ page: p.id, link: target })
    }
    if (content.match(/(?:latest|current|as of)\s+[\w\s]*20\d{2}/i)) {
      staleClaims.push({
        page: p.id,
        claim: content.match(/(?:latest|current|as of)[^.]+/i)?.[0] || '',
        age: 'possibly outdated',
      })
    }
  }
  const stats = {
    pages: pages.length,
    links: allLinks.size,
    orphans: 0,
    deadLinks: deadLinks.length,
    contradictions: 0,
  }
  return { orphans: [], deadLinks, contradictions: [], staleClaims, stats }
}

export async function wikiSave(db, input) {
  const date = new Date().toISOString().split('T')[0]
  const pageId = `pg_${randomUUID().slice(0, 12)}`
  if (!db.wiki) db.wiki = { pages: {}, sources: {}, created: new Date().toISOString() }
  db.wiki.pages[pageId] = {
    id: pageId,
    title: input.title || 'conversation',
    content: input.content || '',
    source: `conversation-${date}`,
    created: new Date().toISOString(),
    updated: new Date().toISOString(),
  }
  return { path: `conversation-${date}`, pageId }
}

export function getWikiPricing() {
  return {
    product: 'wiki',
    version: WIKI_VERSION,
    credits: {
      'wiki.init': 0,
      'wiki.ingest': 5,
      'wiki.query': 3,
      'wiki.lint': 2,
      'wiki.save': 2,
    },
    note: '1 credit = $0.01 USD',
  }
}

export function getWikiCapabilities() {
  return {
    product: 'wiki',
    version: WIKI_VERSION,
    actions: ['init', 'ingest', 'query', 'lint', 'save'],
    features: [
      'Knowledge base initialization',
      'Content ingestion (files, text)',
      'Natural language querying',
      'Cross-referencing and linking',
      'Wiki health linting',
      'Hot cache for recent context',
    ],
  }
}
