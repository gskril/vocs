import PluginRsc from '@vitejs/plugin-rsc'
import type { PluginOption } from 'vite'
import type { Config as WakuConfig } from 'waku/config'
import * as Config from '../internal/config.js'
import { vocs as vocs_core } from '../vite.js'
import { CLOUDFLARE_ADAPTER, getDefaultAdapter } from './internal/patches/utils/default-adapter.js'
import { installPreviewServer } from './internal/patches/utils/preview-server.js'
import * as Plugins from './internal/vite-plugins.js'

/**
 * Creates a Vite plugin for Vocs, with given configuration.
 *
 * @param options - Configuration options.
 * @returns Plugin
 */
export async function vocs(options: vocs.Options = {}): Promise<PluginOption[]> {
  const {
    privateDir = 'private',
    rscBase = 'RSC',
    unstable_adapter = getDefaultAdapter(),
  } = options

  // Waku's Cloudflare adapter builds against a Vite preview server exposed via
  // a global that `vocs build` / raw `vite build` don't set. Install it from the
  // same plugin list, gated on the Cloudflare adapter being selected.
  if (unstable_adapter === CLOUDFLARE_ADAPTER) installPreviewServer(() => vocs(options))

  const config = await Config.resolve()
  const { basePath, srcDir, outDir } = config
  const wakuBasePath = basePath.endsWith('/') ? basePath : `${basePath}/`

  const wakuConfig = {
    basePath: wakuBasePath,
    srcDir,
    distDir: outDir,
    privateDir,
    rscBase,
    unstable_adapter,
    vite: {},
  }

  return [
    vocs_core(),
    Plugins.rsdwNoExternal(),
    Plugins.allowServer(),
    PluginRsc({
      serverHandler: false,
      keepUseCientProxy: true,
      useBuildAppHook: true,
      clientChunks: (meta) => meta.serverChunk,
    }),
    Plugins.mdxHmr(),
    Plugins.buildId(),
    Plugins.environments(wakuConfig),
    Plugins.userEntries(wakuConfig, config),
    Plugins.virtualConfig(wakuConfig),
    Plugins.adapterAlias(wakuConfig),
    Plugins.notFound(),
    Plugins.patchRsdw(),
    Plugins.buildMetadata(wakuConfig),
    Plugins.staticBuild(wakuConfig),
    Plugins.privateDir(wakuConfig),
    Plugins.htmlShell(),
    Plugins.fsRouterTypegen(wakuConfig),
    Plugins.preview(),
    Plugins.vocsConfig(config),
    ...(unstable_adapter === CLOUDFLARE_ADAPTER ? [Plugins.cloudflareRuntime()] : []),
  ]
}

export declare namespace vocs {
  type Options = Omit<WakuConfig, 'basePath' | 'srcDir' | 'vite'>
}
