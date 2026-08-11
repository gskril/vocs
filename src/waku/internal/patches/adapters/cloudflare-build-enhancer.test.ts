import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { gunzipSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import buildEnhancer, {
  type BuildOptions,
  compressBuildMetadata,
  patchWranglerConfig,
} from './cloudflare-build-enhancer.js'

const originalCwd = process.cwd()
let tempDir: string | undefined

afterEach(() => {
  process.chdir(originalCwd)
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true })
  tempDir = undefined
})

function makeTempDir() {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vocs-cf-'))
  return tempDir
}

const serverlessOptions: BuildOptions = {
  srcDir: 'src',
  distDir: 'dist',
  DIST_PUBLIC: 'public',
  serverless: true,
  basePath: '/',
  assetsDir: 'assets',
}

function writeConfig(dir: string, config: unknown) {
  const filePath = path.join(dir, 'wrangler.json')
  fs.writeFileSync(filePath, JSON.stringify(config, null, 2))
  return filePath
}

function readConfig(filePath: string) {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'))
}

describe('patchWranglerConfig', () => {
  it('merges nodejs_compat into existing compatibility flags', () => {
    const dir = makeTempDir()
    const filePath = writeConfig(dir, {
      main: 'index.js',
      compatibility_flags: ['nodejs_als'],
      compatibility_date: '2025-11-17',
    })

    patchWranglerConfig(filePath, serverlessOptions)

    const config = readConfig(filePath)
    expect(config.compatibility_flags).toContain('nodejs_als')
    expect(config.compatibility_flags).toContain('nodejs_compat')
  })

  it('adds nodejs_compat when no flags are present', () => {
    const dir = makeTempDir()
    const filePath = writeConfig(dir, {
      main: 'index.js',
      compatibility_date: '2025-11-17',
    })

    patchWranglerConfig(filePath, serverlessOptions)

    expect(readConfig(filePath).compatibility_flags).toEqual(['nodejs_compat'])
  })

  it('bumps a compatibility date older than the minimum', () => {
    const dir = makeTempDir()
    const filePath = writeConfig(dir, { main: 'index.js', compatibility_date: '2024-01-01' })

    patchWranglerConfig(filePath, serverlessOptions)

    expect(readConfig(filePath).compatibility_date).toBe('2025-04-01')
  })

  it('sets the minimum compatibility date when none is present', () => {
    const dir = makeTempDir()
    const filePath = writeConfig(dir, { main: 'index.js' })

    patchWranglerConfig(filePath, serverlessOptions)

    expect(readConfig(filePath).compatibility_date).toBe('2025-04-01')
  })

  it('preserves a compatibility date newer than the minimum', () => {
    const dir = makeTempDir()
    const filePath = writeConfig(dir, {
      main: 'index.js',
      compatibility_date: '2025-11-17',
    })

    patchWranglerConfig(filePath, serverlessOptions)

    expect(readConfig(filePath).compatibility_date).toBe('2025-11-17')
  })

  it('adds Worker routing and runtime config without overriding module rules', () => {
    const dir = makeTempDir()
    const filePath = writeConfig(dir, {
      main: 'index.js',
      rules: [{ type: 'ESModule', globs: ['**/*.js', '**/*.mjs'] }],
    })

    patchWranglerConfig(filePath, serverlessOptions)

    const config = readConfig(filePath)
    expect(config.run_worker_first).toBeUndefined()
    expect(config.assets.run_worker_first).toEqual(['/*', '!/assets/*'])
    expect(config.vars).toEqual({ NODE_ENV: 'production' })
    expect(config.keep_vars).toBe(true)
    expect(config.rules).toEqual([{ type: 'ESModule', globs: ['**/*.js', '**/*.mjs'] }])
  })

  it('leaves Worker-only config unset for a full-static build', () => {
    const dir = makeTempDir()
    const filePath = writeConfig(dir, { compatibility_date: '2025-11-17' })

    patchWranglerConfig(filePath, { ...serverlessOptions, serverless: false })

    const config = readConfig(filePath)
    expect(config.run_worker_first).toBeUndefined()
    expect(config.vars).toBeUndefined()
    expect(config.rules).toBeUndefined()
    expect(config.compatibility_flags).toBeUndefined()
    expect(config.compatibility_date).toBe('2025-11-17')
  })

  it('prefixes worker-first globs with a non-root basePath', () => {
    const dir = makeTempDir()
    const filePath = writeConfig(dir, { main: 'index.js' })

    patchWranglerConfig(filePath, { ...serverlessOptions, basePath: '/docs/' })

    expect(readConfig(filePath).assets.run_worker_first).toEqual(['/docs/*', '!/docs/assets/*'])
  })
})

describe('compressBuildMetadata (cloudflare)', () => {
  const payload = JSON.stringify([
    ['/', { html: '<html></html>' }],
    ['/about', { html: '<about></about>' }],
  ])

  it('rewrites the metadata module into a gzipped Data sidecar and a workerd-safe loader', () => {
    const dir = makeTempDir()
    const serverDir = path.join(dir, 'server')
    fs.mkdirSync(serverDir, { recursive: true })
    fs.writeFileSync(
      path.join(serverDir, '__waku_build_metadata.js'),
      `export const buildMetadata = new Map(${payload});\n`,
    )

    compressBuildMetadata(serverDir)

    const gzPath = path.join(serverDir, '__waku_build_metadata.bin')
    expect(fs.existsSync(gzPath)).toBe(true)

    // Roundtrip: gunzip the sidecar and compare to the original JSON payload.
    const roundtripped = gunzipSync(fs.readFileSync(gzPath)).toString('utf-8')
    expect(JSON.parse(roundtripped)).toEqual(JSON.parse(payload))

    // The loader must decompress synchronously (no async I/O at module scope on
    // workerd) and import the sidecar as a Data module (ArrayBuffer) — never read
    // from disk like the Vercel variant does.
    const loader = fs.readFileSync(path.join(serverDir, '__waku_build_metadata.js'), 'utf-8')
    expect(loader).toContain("import { gunzipSync } from 'node:zlib'")
    expect(loader).toContain("import compressed from './__waku_build_metadata.bin'")
    expect(loader).toContain('new Uint8Array(compressed)')
    expect(loader).not.toContain('node:fs')
    expect(loader).not.toContain('readFileSync')
  })

  it('skips a malformed metadata module', () => {
    const dir = makeTempDir()
    const serverDir = path.join(dir, 'server')
    fs.mkdirSync(serverDir, { recursive: true })
    fs.writeFileSync(
      path.join(serverDir, '__waku_build_metadata.js'),
      'export const buildMetadata = notAMap;\n',
    )

    compressBuildMetadata(serverDir)

    expect(fs.existsSync(path.join(serverDir, '__waku_build_metadata.bin'))).toBe(false)
    // The malformed module is left untouched.
    expect(fs.readFileSync(path.join(serverDir, '__waku_build_metadata.js'), 'utf-8')).toBe(
      'export const buildMetadata = notAMap;\n',
    )
  })

  it('is a no-op when the metadata module is missing', () => {
    const dir = makeTempDir()
    const serverDir = path.join(dir, 'server')
    fs.mkdirSync(serverDir, { recursive: true })

    expect(() => compressBuildMetadata(serverDir)).not.toThrow()
    expect(fs.existsSync(path.join(serverDir, '__waku_build_metadata.bin'))).toBe(false)
  })
})

describe('cloudflare build enhancer', () => {
  it('patches the build-emitted root wrangler config when the user has none', async () => {
    const dir = makeTempDir()
    process.chdir(dir)

    const build = await buildEnhancer(async () => {})
    await build({}, serverlessOptions)

    // Waku's enhancer emits a root wrangler.jsonc (no user file present).
    const config = JSON.parse(fs.readFileSync(path.resolve('wrangler.jsonc'), 'utf-8'))
    expect(config.compatibility_flags).toContain('nodejs_compat')
    expect(config.assets.run_worker_first).toEqual(['/*', '!/assets/*'])
    expect(config.vars).toEqual({ NODE_ENV: 'production' })
  })

  it('never touches a user-committed root wrangler config', async () => {
    const dir = makeTempDir()
    process.chdir(dir)

    const userConfig = [
      '{',
      '  "name": "my-docs",',
      '  "compatibility_date": "2024-01-01",',
      '  "compatibility_flags": ["nodejs_als"]',
      '}',
      '',
    ].join('\n')
    fs.writeFileSync(path.resolve('wrangler.jsonc'), userConfig)

    const build = await buildEnhancer(async () => {})
    await build({}, serverlessOptions)

    // The user's file is preserved byte-for-byte...
    expect(fs.readFileSync(path.resolve('wrangler.jsonc'), 'utf-8')).toBe(userConfig)

    // ...but the build-emitted dist/server config is still patched.
    const distConfig = JSON.parse(
      fs.readFileSync(path.resolve('dist', 'server', 'wrangler.json'), 'utf-8'),
    )
    expect(distConfig.compatibility_flags).toContain('nodejs_compat')
  })
})
