import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type { Plugin } from 'vite'
import type { Config as WakuConfig } from 'waku/config'
import * as VocsConfig from '../../internal/config.js'
import {
  EXTENSIONS,
  SRC_CLIENT_ENTRY,
  SRC_MIDDLEWARE,
  SRC_PAGES,
  SRC_SERVER_ENTRY,
} from './patches/constants.js'

export {
  unstable_adapterAliasPlugin as adapterAlias,
  unstable_allowServerPlugin as allowServer,
  unstable_buildMetadataPlugin as buildMetadata,
  unstable_environmentsPlugin as environments,
  unstable_htmlShellPlugin as htmlShell,
  unstable_notFoundPlugin as notFound,
  unstable_patchRsdwPlugin as patchRsdw,
  unstable_privateDirPlugin as privateDir,
  unstable_staticBuildPlugin as staticBuild,
  unstable_virtualConfigPlugin as virtualConfig,
} from 'waku/vite-plugins'
export { fsRouterTypegenPlugin as fsRouterTypegen } from './patches/vite-plugins/fs-router-typegen.js'

export function buildId(): Plugin {
  const key = 'import.meta.env.WAKU_BUILD_ID'
  const buildId = randomBytes(6).toString('base64url')

  return {
    name: 'vocs:build-id',
    config(merged, env) {
      if (merged.define && key in merged.define) return
      return {
        define: {
          [key]: JSON.stringify(env.command === 'serve' ? 'dev' : buildId),
        },
      }
    },
  }
}

/**
 * Cloudflare/workerd runtime fixups, applied only when the Cloudflare adapter is
 * selected. Two workerd realities the Node/Vercel targets don't have:
 *
 * 1. `import.meta.url` is `undefined` for uploaded (`no_bundle`) modules, so the
 *    rolldown CJS-interop helper `createRequire(import.meta.url)` — evaluated at
 *    module load in the server entry — throws at boot. Pin it to a valid URL; the
 *    resulting `require` is only ever called by CJS deps that aren't on the
 *    request hot path.
 * 2. `nodejs_compat` doesn't provide `child_process`, `vm`, or `worker_threads`.
 *    They're pulled in by build-time/optional tooling (the rust twoslash
 *    highlighter and git metadata shell out; the OpenAPI parser evaluates `vm`
 *    and spins a worker thread), imported at module load in chunks that the
 *    request path touches (the config bundle on every request; the OpenAPI
 *    chunks when Waku registers routes). The stub delegates to the real builtin
 *    when it can be imported — which the Node SSG pass needs, since it executes
 *    those modules for real — and falls back to a workerd-safe shim otherwise.
 *    Their functions are never reached by core page routes at runtime.
 */
export function cloudflareRuntime(): Plugin {
  // bare builtin name -> named exports the shim must provide (default is always
  // exported). Missing a name is a build error, so cover every binding imported.
  const stubbed: Record<string, string[]> = {
    child_process: ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'],
    vm: ['Script', 'createContext', 'runInNewContext', 'runInThisContext', 'compileFunction'],
    worker_threads: ['Worker', 'isMainThread', 'parentPort', 'workerData', 'threadId'],
  }
  const prefix = '\0vocs:cf-node-stub:'
  const bareName = (id: string) => (id.startsWith('node:') ? id.slice(5) : id)

  function stubModule(spec: string) {
    const bare = bareName(spec)
    const names = stubbed[bare] ?? []
    // Shim values used only on workerd, where these APIs aren't reached: enough
    // structure to load (a no-op `vm.Script`, `worker_threads.isMainThread`) and
    // throwing functions everywhere else.
    const shim: Record<string, string> = {
      Script:
        'class { constructor() {} runInContext() {} runInNewContext() {} runInThisContext() {} }',
      createContext: '(ctx) => ctx ?? {}',
      isMainThread: 'true',
      parentPort: 'null',
      workerData: 'null',
      threadId: '0',
      Worker: `class { constructor() { throw new Error('worker_threads is unavailable on Cloudflare Workers') } }`,
    }
    const lines = [
      'let real = {}',
      // Delegated back to the real builtin (see resolveId); resolves on Node, rejects on workerd.
      `try { real = await import(${JSON.stringify(spec)}) } catch {}`,
      'const mod = real.default ?? real',
    ]
    for (const name of names) {
      const fallback =
        shim[name] ?? `(() => { throw new Error('${name} is unavailable on Cloudflare Workers') })`
      lines.push(`export const ${name} = mod.${name} ?? (${fallback})`)
    }
    lines.push(
      `export default (mod && (${names.map((n) => `mod.${n}`).join(' ?? ') || 'false'}) ? mod : { ${names.join(', ')} })`,
    )
    return `${lines.join('\n')}\n`
  }

  return {
    name: 'vocs:cloudflare-runtime',
    // Resolve before Vite externalizes the Node builtins in the server envs.
    enforce: 'pre',
    resolveId(id, importer) {
      // The stub's own delegated `import()` must reach the real builtin.
      if (importer?.startsWith(prefix)) return null
      if (id.startsWith(prefix)) return id
      if (bareName(id) in stubbed) return prefix + id
      // Swap the OG asset module for its Cloudflare variant, which imports the
      // takumi wasm as a CompiledWasm module instead of fetching + compiling
      // bytes (forbidden on workerd). Only the `handlers` OG trampoline
      // (`import.meta.glob('./og-assets.{js,ts}')`) imports it, always from the
      // same directory, so the redirect is scoped to that importer.
      if (
        (id === './og-assets.js' || id === './og-assets.ts') &&
        importer &&
        /[\\/]server[\\/]handlers\.[jt]s$/.test(importer)
      ) {
        const dir = path.dirname(importer)
        for (const ext of ['.js', '.ts']) {
          const candidate = path.join(dir, `og-assets.cloudflare${ext}`)
          if (existsSync(candidate)) return candidate
        }
      }
      return
    },
    load(id) {
      if (!id.startsWith(prefix)) return
      return stubModule(id.slice(prefix.length))
    },
    renderChunk(code) {
      if (!code.includes('createRequire(import.meta.url)')) return null
      return {
        code: code.replaceAll(
          'createRequire(import.meta.url)',
          'createRequire("file:///worker.js")',
        ),
        map: null,
      }
    },
  }
}

/**
 * Keeps `react-server-dom-webpack` bundled in the server environments so Waku's rsdw
 * patch can redirect it to plugin-rsc's vendored build. npm and bun auto-install the
 * peer, which would otherwise load natively with `react` missing the `react-server`
 * condition and crash the dev server.
 */
export function rsdwNoExternal(): Plugin {
  const rsdw = 'react-server-dom-webpack'
  return {
    name: 'vocs:rsdw-no-external',
    config() {
      return {
        environments: {
          rsc: { resolve: { noExternal: [rsdw] } },
          ssr: { resolve: { noExternal: [rsdw] } },
        },
      }
    },
  }
}

/**
 * Builds a script to preview the build output.
 */
export function preview(): Plugin {
  let outDir: string

  return {
    name: 'vocs:preview',
    apply: 'build',
    configResolved(resolvedConfig) {
      outDir = path.resolve(resolvedConfig.root, resolvedConfig.build.outDir)
    },
    async closeBundle() {
      const previewScript = `\
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';

const serveNodePath = join(import.meta.dirname, 'serve-node.js');

if (!existsSync(serveNodePath)) {
  console.error('Error: serve-node.js not found.');
  console.error('The preview script is only compatible with the Node.js adapter for now.');
  process.exit(1);
}

function findFreePort(startPort = 3000) {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(startPort, () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') resolve(findFreePort(startPort + 1));
      else reject(err);
    });
  });
}

process.env.PORT ??= String(await findFreePort());

console.log(\`Starting preview server at http://localhost:\${process.env.PORT}\`);

await import('./serve-node.js');
`

      const previewPath = path.join(outDir, 'preview.js')
      if (!existsSync(outDir)) await fs.mkdir(outDir, { recursive: true })
      await fs.writeFile(previewPath, previewScript, { encoding: 'utf-8' })
    },
  }
}

export function mdxHmr(): Plugin {
  const virtualModuleId = 'virtual:vocs/mdx-hmr'
  const resolvedVirtualModuleId = `\0${virtualModuleId}`
  let version = 0
  let isBuild = false

  return {
    name: 'vocs:mdx-hmr',
    configResolved(config) {
      isBuild = config.command === 'build'
    },
    async hotUpdate({ file }) {
      if (!file.endsWith('.md') && !file.endsWith('.mdx')) return
      if (this.environment.name !== 'client') return
      version++
      const mod =
        this.environment.moduleGraph.getModuleById(resolvedVirtualModuleId) ??
        (await this.environment.moduleGraph.getModuleByUrl(`/@id/__x00__${virtualModuleId}`))
      if (!mod) return
      return [mod]
    },
    resolveId(id) {
      if (id === virtualModuleId) return resolvedVirtualModuleId
      return
    },
    load(id) {
      if (id !== resolvedVirtualModuleId) return
      if (isBuild) return ''
      return `\
const version = ${version};

if (import.meta.hot) {
  const previousVersion = import.meta.hot.data.version;
  import.meta.hot.data.version = version;
  import.meta.hot.accept();

  if (previousVersion !== undefined && previousVersion !== version) {
    const refetchRoute = globalThis.__WAKU_REFETCH_ROUTE__;
    if (refetchRoute) refetchRoute();
  }
}
`
    },
  }
}

export function userEntries(config: Required<WakuConfig>, vocsConfig: VocsConfig.Config): Plugin {
  return {
    name: 'waku:vite-plugins:user-entries',
    // resolve user entries and fallbacks to "managed mode" if not found.
    async resolveId(source, _importer, options) {
      if (source === 'virtual:vite-rsc-waku/server-entry') return '\0' + source
      if (source === 'virtual:vite-rsc-waku/server-entry-inner') {
        const resolved = await this.resolve(
          `/${config.srcDir}/${SRC_SERVER_ENTRY}`,
          undefined,
          options,
        )
        return resolved ? resolved : '\0' + source
      }
      if (source === 'virtual:vite-rsc-waku/client-entry') {
        const resolved = await this.resolve(
          `/${config.srcDir}/${SRC_CLIENT_ENTRY}`,
          undefined,
          options,
        )
        return resolved ? resolved : '\0' + source
      }
      return
    },
    load(id) {
      if (id === '\0virtual:vite-rsc-waku/server-entry') {
        return `\
export { default } from 'virtual:vite-rsc-waku/server-entry-inner';
if (import.meta.hot) {
  import.meta.hot.accept()
}
`
      }
      if (id === '\0virtual:vite-rsc-waku/server-entry-inner') {
        const globBase = `/${config.srcDir}/${SRC_PAGES}`
        const globPattern = `${globBase}/**/*.{${EXTENSIONS.map((ext) => ext.slice(1)).join(',')}}`
        const middlewareGlob = `/${config.srcDir}/${SRC_MIDDLEWARE}/*.{${EXTENSIONS.map((ext) => ext.slice(1)).join(',')}}`
        const loadOpenapi = vocsConfig.openapi?.length
          ? `, loadOpenapi: () => import('vocs/waku/internal/openapi')`
          : ''
        return `
import { middlewareModules } from 'vocs/waku/middleware';
import { router } from 'vocs/waku/internal/router';
import adapter from ${JSON.stringify(config.unstable_adapter)};

export default adapter(
  router(
    import.meta.glob(
      ${JSON.stringify(globPattern)}
    ),
    { srcDir: ${JSON.stringify(config.srcDir)}${loadOpenapi} }
  ),
  {
    middlewareModules: middlewareModules(
      import.meta.glob(${JSON.stringify(middlewareGlob)})
    ),
    static: ${vocsConfig.renderStrategy === 'full-static'},
  },
);
`
      }
      if (id === '\0virtual:vite-rsc-waku/client-entry') {
        return `
import { StrictMode, createElement } from 'react';
import { createRoot, hydrateRoot } from 'react-dom/client';
import { Router } from 'waku/router/client';
import 'virtual:vocs/mdx-hmr';

const rootElement = createElement(StrictMode, null, createElement(Router));

if (globalThis.__WAKU_HYDRATE__) {
  hydrateRoot(document, rootElement);
} else {
  createRoot(document).render(rootElement);
}

if (import.meta.hot)
  import.meta.hot.on('vocs:config', (data) => {
    globalThis.dispatchEvent(new CustomEvent('vocs:config', { detail: data }));
  });
`
      }
      return
    },
  }
}

/**
 * Bundles vocs.config.ts into the server build output via the
 * `virtual:vocs/server-config` module that `Config.resolve` imports in production.
 */
export function vocsConfig(config: VocsConfig.Config): Plugin {
  const configFile = VocsConfig.getConfigFile({ rootDir: config.rootDir })
  const configPath = configFile ? path.resolve(config.rootDir, configFile) : undefined
  const configDir = configPath ? path.dirname(configPath) : undefined

  // Backs `import('virtual:vocs/server-config')` in `Config.resolve` so the
  // server bundle reaches the emitted config through a statically analyzable
  // specifier (works on Node/Vercel and on workerd, which cannot import a
  // runtime-computed absolute path).
  const serverConfigId = 'virtual:vocs/server-config'
  const resolvedServerConfigId = `\0${serverConfigId}`

  // Track files directly imported by the config to bundle together
  const imports = new Set<string>()

  return {
    name: 'vocs:config-bundle',
    config() {
      return {
        environments: {
          rsc: {
            build: {
              rolldownOptions: {
                external: ['fsevents', 'vite'],
                output: {
                  manualChunks(id) {
                    // Only bundle files explicitly imported by vocs.config
                    if (imports.has(id)) return 'vocs.config'
                    return undefined
                  },
                },
              },
            },
            resolve: {
              noExternal: ['@takumi-rs/wasm', '@takumi-rs/image-response'],
            },
          },
        },
      }
    },
    // Track which local files the config imports (e.g. sidebar.ts)
    resolveId(source, importer) {
      if (source === serverConfigId) return resolvedServerConfigId
      if (!configPath || !configDir || !importer) return null
      // If the importer is the config file and source is a relative import
      if (importer === configPath && source.startsWith('./')) {
        const resolved = path.resolve(configDir, source)
        // Find the actual file with extension
        for (const ext of ['.ts', '.tsx', '.js', '.jsx', '.mjs']) {
          const fullPath = resolved.endsWith(ext) ? resolved : resolved + ext
          if (existsSync(fullPath)) {
            imports.add(fullPath)
            break
          }
        }
      }
      return null
    },
    load(id) {
      if (id !== resolvedServerConfigId) return
      if (!configPath) return 'export default {}'
      return `export { default } from ${JSON.stringify(configPath)}`
    },
  }
}
