import { describe, expect, it } from 'vitest'
import { type AssetsBinding, isAvailable, mcpPageSource } from './cloudflare-assets.js'

function assets(files: Record<string, string>): AssetsBinding {
  return {
    async fetch(request) {
      const body = files[new URL(request.url).pathname]
      return body === undefined ? new Response(null, { status: 404 }) : new Response(body)
    },
  }
}

describe('mcpPageSource', () => {
  it('lists internal pages from the generated llms index', async () => {
    const source = mcpPageSource({
      loadAssets: async () =>
        assets({
          '/llms.txt': [
            '# Docs',
            '',
            '- [Home](/index)',
            '- [Guide](/guide/)',
            '- [[EP 1] Governance](/proposals/1): Voting and governance',
            '- [External](https://example.com/docs)',
          ].join('\n'),
        }),
    })

    await expect(source.listPages()).resolves.toEqual(['/', '/guide', '/proposals/1'])
    await expect(source.searchPages?.('governance')).resolves.toEqual([
      { path: '/proposals/1', snippet: 'Voting and governance' },
    ])
  })

  it('reads generated Markdown twins', async () => {
    const source = mcpPageSource({
      loadAssets: async () => assets({ '/assets/md/guide.md': '# Guide' }),
    })

    await expect(source.readPage('/guide/')).resolves.toBe('# Guide')
    await expect(source.readPage('/missing')).resolves.toBeNull()
  })

  it('falls back when the Assets binding is unavailable', async () => {
    const source = mcpPageSource({ loadAssets: async () => undefined })

    await expect(source.listPages()).resolves.toBeUndefined()
    await expect(source.readPage('/guide')).resolves.toBeUndefined()
  })
})

describe('isAvailable', () => {
  it('is false outside workerd', async () => {
    await expect(isAvailable()).resolves.toBe(false)
  })
})
