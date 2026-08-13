import type * as Mcp from '../../internal/mcp.js'

export type AssetsBinding = { fetch: (request: Request) => Promise<Response> }

// Keep the platform module out of Node bundles. It is supplied by workerd and
// exposes the current Worker's bindings when the route runs on Cloudflare.
const DO_NOT_BUNDLE = ''

async function loadAssets(): Promise<AssetsBinding | undefined> {
  try {
    const { env } = (await import(/* @vite-ignore */ DO_NOT_BUNDLE + 'cloudflare:workers')) as {
      env?: { ASSETS?: AssetsBinding }
    }
    return env?.ASSETS
  } catch {
    return undefined
  }
}

export async function isAvailable() {
  return !!(await loadAssets())
}

function normalizePagePath(pagePath: string) {
  const pathname = new URL(pagePath, 'https://assets.local').pathname
    .replace(/\.md$/, '')
    .replace(/\/index$/, '')
    .replace(/\/$/, '')
  return pathname || '/'
}

async function loadPageEntries(assets: AssetsBinding) {
  const response = await assets.fetch(new Request('https://assets.local/llms.txt'))
  if (!response.ok) return []

  const entries: { path: string; snippet: string; text: string }[] = []
  const markdown = await response.text()
  for (const match of markdown.matchAll(/^\s*-\s+\[(.*)\]\(([^)\s]+)\)(?::\s*(.*))?$/gm)) {
    const [, title, href, description = ''] = match
    if (!title || !href) continue
    const url = new URL(href, 'https://assets.local')
    if (url.origin !== 'https://assets.local') continue
    const path = normalizePagePath(url.pathname)
    entries.push({ path, snippet: description || title, text: `${title} ${description} ${path}` })
  }
  return entries
}

export function mcpPageSource(options: mcpPageSource.Options = {}): Mcp.PageSource {
  const getAssets = options.loadAssets ?? loadAssets

  return {
    async listPages() {
      const assets = await getAssets()
      if (!assets) return undefined

      return [...new Set((await loadPageEntries(assets)).map((entry) => entry.path))]
    },
    async readPage(pagePath) {
      const assets = await getAssets()
      if (!assets) return undefined

      const normalized = normalizePagePath(pagePath)
      const assetPath = `/assets/md/${normalized === '/' ? 'index' : normalized.slice(1)}.md`
      const response = await assets.fetch(new Request(`https://assets.local${assetPath}`))
      if (!response.ok) return null
      return response.text()
    },
    async searchPages(query) {
      const assets = await getAssets()
      if (!assets) return undefined

      const normalized = query.trim().toLowerCase()
      if (!normalized) return []
      return (await loadPageEntries(assets))
        .filter((entry) => entry.text.toLowerCase().includes(normalized))
        .map(({ path, snippet }) => ({ path, snippet }))
        .slice(0, 20)
    },
  }
}

export declare namespace mcpPageSource {
  type Options = {
    loadAssets?: (() => Promise<AssetsBinding | undefined>) | undefined
  }
}
