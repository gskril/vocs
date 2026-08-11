import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

// Waku emits `dist/server/__waku_build_metadata.js` as
// `export const buildMetadata = new Map(<json>);` where `<json>` is a
// JSON-stringified `Array<[string, unknown]>`. The inlined RSC/HTML payloads
// grow with the site and can reach tens of MB, so adapters rewrite it into a
// compressed sidecar plus a tiny loader.
export const BUILD_METADATA_FILE = '__waku_build_metadata.js'
export const BUILD_METADATA_COMPRESSED_FILE = '__waku_build_metadata.bin'

/**
 * Reads and validates Waku's emitted build metadata module, returning the raw
 * JSON payload string (the argument to `new Map(...)`). Returns `undefined`
 * when the module is missing or does not match the expected shape, so callers
 * can skip the rewrite defensively.
 */
export function readBuildMetadataJson(serverDir: string): string | undefined {
  const file = path.join(serverDir, BUILD_METADATA_FILE)
  if (!existsSync(file)) return undefined
  const code = readFileSync(file, 'utf-8')
  const match = code.match(/^export const buildMetadata = new Map\((.*)\);\s*$/s)
  const json = match?.[1]
  if (!json) return undefined
  try {
    if (!Array.isArray(JSON.parse(json))) return undefined
  } catch {
    return undefined
  }
  return json
}
