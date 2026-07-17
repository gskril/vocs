import react from '@vitejs/plugin-react'
import { type PluginOption, preview } from 'vite'
import type { unstable_startPreviewServer } from 'waku/adapter-builders'

type PreviewServer = Awaited<ReturnType<typeof unstable_startPreviewServer>>

declare global {
  // Declared by Waku (`waku/dist/lib/global-types.d.ts`), but that ambient
  // module isn't transitively in scope here — redeclare with the same type.
  var __WAKU_START_PREVIEW_SERVER__: (() => Promise<PreviewServer>) | undefined
}

/**
 * Waku's Cloudflare adapter builds by running the app against a Vite preview
 * server it obtains from this global. Waku's own CLI sets it, but `vocs build`
 * (`src/cli.ts`) and raw `vite build` don't, so install it here from the same
 * plugin list the build uses. Idempotent so the preview server re-invoking the
 * `vocs()` factory doesn't reinstall it.
 */
export function installPreviewServer(makePlugins: () => Promise<PluginOption[]>) {
  globalThis.__WAKU_START_PREVIEW_SERVER__ ??= async () => {
    const server = await preview({ configFile: false, plugins: [react(), await makePlugins()] })
    return {
      baseUrl: server.resolvedUrls?.local[0] ?? '',
      middlewares: { use: (fn) => server.middlewares.use(fn) },
      close: () => server.close(),
    }
  }
}
