import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import wakuBuildEnhancer from 'waku/adapters/cloudflare-build-enhancer'

export type BuildOptions = {
  srcDir: string
  distDir: string
  DIST_PUBLIC: string
  serverless: boolean
}

// nodejs_compat populates `process.env` from vars/secrets only from this date
// on; Vocs reads `process.env` at request time, so an older date is unsafe.
const MIN_COMPATIBILITY_DATE = '2025-04-01'
// Vocs needs full `nodejs_compat`; Waku's default `nodejs_als` is insufficient.
const REQUIRED_COMPATIBILITY_FLAG = 'nodejs_compat'
const rootWranglerFiles = ['wrangler.toml', 'wrangler.json', 'wrangler.jsonc']

/**
 * Applies the Vocs deltas to a wrangler config emitted by Waku's enhancer:
 * ensures `nodejs_compat` is present (merged with existing flags) and the
 * compatibility date is recent enough. Only ever called on build-emitted JSON
 * files — never a user's own config.
 */
function patchWranglerConfig(filePath: string) {
  const config = JSON.parse(readFileSync(filePath, 'utf-8'))

  const flags = new Set<string>(
    Array.isArray(config.compatibility_flags) ? config.compatibility_flags : [],
  )
  flags.add(REQUIRED_COMPATIBILITY_FLAG)
  config.compatibility_flags = [...flags]

  if (
    typeof config.compatibility_date !== 'string' ||
    config.compatibility_date < MIN_COMPATIBILITY_DATE
  )
    config.compatibility_date = MIN_COMPATIBILITY_DATE

  writeFileSync(filePath, `${JSON.stringify(config, null, 2)}\n`)
}

// TODO(phase-b): emit `run_worker_first` globs (worker-first for page routes,
// asset-served for `/assets/*`) so partial-static clean URLs reach mdRouter.
export default async function buildEnhancer(
  build: (utils: unknown, options: BuildOptions) => Promise<void>,
): Promise<typeof build> {
  const wakuEnhanced = await wakuBuildEnhancer(build)

  return async (utils: unknown, options: BuildOptions) => {
    // Waku respects a user's own root wrangler config and only writes one when
    // absent. Record whether one already exists so we never patch a user file.
    const rootWranglerBefore = rootWranglerFiles.some((file) => existsSync(path.resolve(file)))

    await wakuEnhanced(utils, options)

    if (!rootWranglerBefore) {
      const emitted = rootWranglerFiles.find((file) => existsSync(path.resolve(file)))
      if (emitted) patchWranglerConfig(path.resolve(emitted))
    }

    const distServerWrangler = path.resolve(options.distDir, 'server', 'wrangler.json')
    if (existsSync(distServerWrangler)) patchWranglerConfig(distServerWrangler)
  }
}
