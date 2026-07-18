import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { gzipSync } from 'node:zlib'
import wakuBuildEnhancer, {
  type BuildOptions as WakuBuildOptions,
} from 'waku/adapters/cloudflare-build-enhancer'
import {
  BUILD_METADATA_FILE,
  BUILD_METADATA_GZ_FILE,
  readBuildMetadataJson,
} from '../utils/build-metadata.js'

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
 * Rewrites Waku's build metadata (inlined RSC payloads, tens of MB — they
 * scale with the site and bloat the uploaded Worker) into a gzipped sidecar
 * plus a workerd-safe loader. The sidecar is uploaded as a wrangler Data
 * module (see the `Data` rule in `patchWranglerConfig`), which exports its
 * bytes as an `ArrayBuffer`; the loader decompresses them with `node:zlib`
 * (available under the `nodejs_compat` flag the enhancer already emits) so
 * `buildMetadata` is a plain `Map` when `handler.js`'s top-level
 * `import { buildMetadata }` resolves. Decompression must be synchronous:
 * workerd forbids asynchronous I/O in module global scope, so a streaming
 * `DecompressionStream` at import time is rejected — `gunzipSync` is pure CPU
 * and is allowed.
 */
export function compressBuildMetadata(serverDir: string) {
  const json = readBuildMetadataJson(serverDir)
  if (!json) return
  writeFileSync(path.join(serverDir, BUILD_METADATA_GZ_FILE), gzipSync(json, { level: 9 }))
  writeFileSync(
    path.join(serverDir, BUILD_METADATA_FILE),
    [
      `import { gunzipSync } from 'node:zlib';`,
      `import compressed from './${BUILD_METADATA_GZ_FILE}';`,
      `export const buildMetadata = new Map(JSON.parse(gunzipSync(new Uint8Array(compressed)).toString('utf8')));`,
      '',
    ].join('\n'),
  )
}

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
export function patchWranglerConfig(filePath: string, options: BuildOptions) {
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
    // bytes at runtime. The compressed build-metadata sidecar ships as a Data
    // module so the loader can import its bytes as an ArrayBuffer. Keep Waku's
    // existing ESModule rule.
    const rules: Array<{ type: string; globs: string[] }> = Array.isArray(config.rules)
      ? config.rules
      : []
    if (!rules.some((rule) => rule.type === 'CompiledWasm'))
      rules.push({ type: 'CompiledWasm', globs: ['**/*.wasm'] })
    if (!rules.some((rule) => rule.type === 'Data'))
      rules.push({ type: 'Data', globs: ['**/*.json.gz'] })
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

    // Runs after the wrapped build (SSG has already consumed the original
    // module). Only serverless builds ship a Worker; full-static ones don't.
    if (options.serverless) compressBuildMetadata(path.resolve(options.distDir, 'server'))

    if (!rootWranglerBefore) {
      const emitted = rootWranglerFiles.find((file) => existsSync(path.resolve(file)))
      if (emitted) patchWranglerConfig(path.resolve(emitted), options)
    }

    const distServerWrangler = path.resolve(options.distDir, 'server', 'wrangler.json')
    if (existsSync(distServerWrangler)) patchWranglerConfig(distServerWrangler, options)
  }
}
