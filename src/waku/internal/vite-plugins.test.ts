import { describe, expect, it } from 'vitest'
import type { Config as WakuConfig } from 'waku/config'
import type * as VocsConfig from '../../internal/config.js'
import { userEntries } from './vite-plugins.js'

function loadServerEntry(
  openapi?: VocsConfig.Config['openapi'],
  unstable_adapter = 'vocs/waku/internal/patches/adapters/node',
) {
  const plugin = userEntries(
    { srcDir: 'src', unstable_adapter } as Required<WakuConfig>,
    { openapi } as VocsConfig.Config,
  )
  const load = plugin.load as (id: string) => string | undefined
  return load('\0virtual:vite-rsc-waku/server-entry-inner')
}

describe('userEntries', () => {
  it('imports the selected adapter directly', () => {
    expect(loadServerEntry(undefined, 'vocs/waku/internal/patches/adapters/cloudflare')).toContain(
      'import adapter from "vocs/waku/internal/patches/adapters/cloudflare"',
    )
  })

  it('omits the OpenAPI runtime when OpenAPI is disabled', () => {
    const entry = loadServerEntry()
    expect(entry).toContain("from 'vocs/waku/internal/router'")
    expect(entry).not.toContain('vocs/waku/internal/openapi')
  })

  it('loads the OpenAPI runtime when OpenAPI is enabled', () => {
    const openapi = [{ path: '/api', spec: './openapi.json' }] as VocsConfig.Config['openapi']
    expect(loadServerEntry(openapi)).toContain(
      "loadOpenapi: () => import('vocs/waku/internal/openapi')",
    )
  })
})
