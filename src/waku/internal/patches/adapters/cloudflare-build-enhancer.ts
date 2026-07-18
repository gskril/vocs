import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import wakuBuildEnhancer, {
  type BuildOptions as WakuBuildOptions,
} from 'waku/adapters/cloudflare-build-enhancer'

export type BuildOptions = {
  srcDir: string
  distDir: string
  DIST_PUBLIC: string
  serverless: boolean
  basePath: string
  assetsDir: string
}

// nodejs_compat populates `process.env` from vars/secrets only from this date
// on; Vocs reads `process.env` at request time, so an older date is unsafe.
const MIN_COMPATIBILITY_DATE = '2025-04-01'
// Vocs needs full `nodejs_compat`; Waku's default `nodejs_als` is insufficient.
const REQUIRED_COMPATIBILITY_FLAG = 'nodejs_compat'
const rootWranglerFiles = ['wrangler.toml', 'wrangler.json', 'wrangler.jsonc']

/**
 * Applies the Vocs deltas to a wrangler config emitted by Waku's enhancer:
 * - ensures `nodejs_compat` is present (merged with existing flags) and the
 *   compatibility date is recent enough;
 * - for a config that ships a Worker (serverless), routes page URLs to the
 *   Worker first (so mdRouter can negotiate markdown and the Worker can serve
 *   prerendered HTML) while keeping the hashed `/assets/*` output — chunks,
 *   styles and markdown twins — asset-served without invoking the Worker, and
 *   pins `NODE_ENV=production` for any runtime `process.env` reads.
 *
 * Only ever called on build-emitted JSON files — never a user's own config.
 */
function patchWranglerConfig(filePath: string, options: BuildOptions) {
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

  // Full-static configs ship no Worker (no `main`); routing/vars are meaningless
  // and Workers Assets serves everything directly.
  if (options.serverless && config.main) {
    // `basePath` already ends with `/`. Everything is Worker-first except the
    // hashed asset directory. Top-level `public/` files (favicons, llms.txt,
    // SKILL.md) share the URL space with prerendered page HTML, which must reach
    // the Worker for markdown negotiation, so they are Worker-first too and are
    // served straight from the ASSETS binding by the adapter's static middleware.
    config.run_worker_first = [`${options.basePath}*`, `!${options.basePath}${options.assetsDir}/*`]
    config.vars = { ...config.vars, NODE_ENV: 'production' }

    // The OG handler's takumi wasm ships in the server bundle and must be
    // uploaded as a CompiledWasm module — workerd forbids compiling wasm from
    // bytes at runtime. Keep Waku's existing ESModule rule.
    const rules: Array<{ type: string; globs: string[] }> = Array.isArray(config.rules)
      ? config.rules
      : []
    if (!rules.some((rule) => rule.type === 'CompiledWasm'))
      rules.push({ type: 'CompiledWasm', globs: ['**/*.wasm'] })
    config.rules = rules
  }

  writeFileSync(filePath, `${JSON.stringify(config, null, 2)}\n`)
}

export default async function buildEnhancer(
  build: (utils: unknown, options: BuildOptions) => Promise<void>,
): Promise<typeof build> {
  // Waku's enhancer type omits `basePath`/`assetsDir` (the Vocs adapter passes
  // them through at runtime); the wrapped `build` is structurally compatible.
  const wakuEnhanced = (await wakuBuildEnhancer(
    build as (utils: unknown, options: WakuBuildOptions) => Promise<void>,
  )) as unknown as typeof build

  return async (utils: unknown, options: BuildOptions) => {
    // Waku respects a user's own root wrangler config and only writes one when
    // absent. Record whether one already exists so we never patch a user file.
    const rootWranglerBefore = rootWranglerFiles.some((file) => existsSync(path.resolve(file)))

    await wakuEnhanced(utils, options)

    if (!rootWranglerBefore) {
      const emitted = rootWranglerFiles.find((file) => existsSync(path.resolve(file)))
      if (emitted) patchWranglerConfig(path.resolve(emitted), options)
    }

    const distServerWrangler = path.resolve(options.distDir, 'server', 'wrangler.json')
    if (existsSync(distServerWrangler)) patchWranglerConfig(distServerWrangler, options)
  }
}
