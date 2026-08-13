import type { MiddlewareHandler } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { Hono } from 'hono/tiny'
import {
  unstable_createServerEntryAdapter as createServerEntryAdapter,
  unstable_startPreviewServer as startPreviewServer,
} from 'waku/adapter-builders'
import {
  unstable_constants as constants,
  unstable_consumeMultiplexedStream as consumeMultiplexedStream,
  unstable_honoMiddleware as honoMiddleware,
  unstable_produceMultiplexedStream as produceMultiplexedStream,
} from 'waku/internals'

const { DIST_PUBLIC } = constants
const { rscMiddleware, middlewareRunner } = honoMiddleware

const DEFAULT_BODY_LIMIT_MAX_SIZE = 100 * 1024 * 1024

// Empty specifier keeps the dynamic import out of the bundle so it resolves
// against the Workers runtime (`cloudflare:workers`, `node:stream`) at runtime.
const DO_NOT_BUNDLE = ''
const PRUNABLE_KEY_PREFIX = '\0__prunable__/'

const vocsCloudflareBuildEnhancer = 'vocs/waku/internal/patches/adapters/cloudflare-build-enhancer'

type MiddlewareModules = Record<
  string,
  () => Promise<{ default: (opts: { app: Hono }) => MiddlewareHandler }>
>

const emptyStream = () =>
  new ReadableStream({
    start(controller) {
      controller.close()
    },
  })

function isProductionWorker(req: Request) {
  // This header is only set for production Cloudflare Workers.
  return !!req.headers.get('cf-visitor')
}

function isLoopbackRequest(req: Request) {
  const { hostname } = new URL(req.url)
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname === '[::1]'
  )
}

function removeGzipEncoding(res: Response) {
  const contentType = res.headers.get('content-type')
  if (!contentType || contentType.includes('text/html') || contentType.includes('text/plain')) {
    const headers = new Headers(res.headers)
    headers.set('content-encoding', 'Identity')
    return new Response(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers,
    })
  }
  return res
}

const adapter: typeof import('waku/adapters/cloudflare').default = createServerEntryAdapter(
  ({ processRequest, processBuild, setAllEnv, config, isBuild, notFoundHtml }, options) => {
    const {
      bodyLimit: bodyLimitOptions,
      middlewareFns = [],
      middlewareModules = {},
      internalPathToBuildStaticFiles = '__waku_internal_build_static_files',
    } = options || {}
    const typedMiddlewareModules = middlewareModules as MiddlewareModules
    const app = new Hono()

    app.notFound((context) => {
      if (notFoundHtml) return context.html(notFoundHtml, 404)
      return context.text('404 Not Found', 404)
    })

    // Mirrors the Node adapter: Vocs needs mdRouter to run first for
    // partial-static clean URLs that negotiate `text/markdown`. On Workers,
    // static assets are served by Workers Assets before the Worker runs.
    if (isBuild && typedMiddlewareModules['mdRouter']) {
      const mdRouterMiddleware = middlewareRunner(
        {
          mdRouter: typedMiddlewareModules['mdRouter'],
        },
        { app },
      )
      app.use(`${config.basePath}*`, (context, next) => {
        const url = new URL(context.req.url)
        // Generated markdown assets are already static output. Passing them
        // through mdRouter here would route back to the same file.
        if (url.pathname.startsWith(`${config.basePath}assets/`)) return next()
        return mdRouterMiddleware(context, next)
      })
    }

    // Node's adapter serves the prerendered static output from disk here (before
    // the RSC middleware). On Workers the equivalent output lives in Workers
    // Assets: `run_worker_first` routes page URLs to the Worker (so mdRouter can
    // negotiate markdown), so the Worker must serve their prerendered HTML itself.
    // The ASSETS binding reads the asset store directly and never re-invokes the
    // Worker, so this can't loop; a 404 falls through to dynamic RSC rendering.
    if (isBuild) {
      app.use(`${config.basePath}*`, async (context, next) => {
        if (context.req.method !== 'GET' && context.req.method !== 'HEAD') return next()
        const assets = (
          context.env as { ASSETS?: { fetch: (request: Request) => Promise<Response> } } | undefined
        )?.ASSETS
        if (!assets) return next()
        const res = await assets.fetch(context.req.raw)
        if (res.status === 404) return next()
        return res
      })
    }

    if (bodyLimitOptions !== false)
      app.use(bodyLimit(bodyLimitOptions ?? { maxSize: DEFAULT_BODY_LIMIT_MAX_SIZE }))
    for (const middlewareFn of middlewareFns) app.use(middlewareFn({ app }))
    app.use(middlewareRunner(typedMiddlewareModules, { app }))
    app.use(rscMiddleware({ processRequest }))

    const buildOptions = {
      srcDir: config.srcDir,
      distDir: config.distDir,
      DIST_PUBLIC,
      serverless: !options?.static,
      basePath: config.basePath,
      assetsDir: options?.assetsDir || 'assets',
    }

    const buildBody = () =>
      produceMultiplexedStream(async (emitFile) => {
        await processBuild({
          emitFile,
          unstable_registerPrunableFile: (srcPath) =>
            emitFile(PRUNABLE_KEY_PREFIX + srcPath, emptyStream()),
        })
      })

    const fetchFn = async (req: Request) => {
      if (
        new URL(req.url).pathname === `/${internalPathToBuildStaticFiles}` &&
        isLoopbackRequest(req) &&
        !isProductionWorker(req)
      ) {
        return new Response(buildBody())
      }
      let cloudflareContext:
        | {
            env: Readonly<Record<string, unknown>>
            waitUntil: (promise: Promise<unknown>) => void
            passThroughOnException: () => void
          }
        | undefined
      try {
        cloudflareContext = await import(/* @vite-ignore */ DO_NOT_BUNDLE + 'cloudflare:workers')
      } catch {
        // Not in a Cloudflare environment.
      }
      let res: Response | Promise<Response>
      if (cloudflareContext) {
        const { env, waitUntil, passThroughOnException } = cloudflareContext
        res = app.fetch(req, env, {
          waitUntil,
          passThroughOnException,
          props: undefined,
        })
      } else {
        res = app.fetch(req)
      }
      // Workaround https://github.com/cloudflare/workers-sdk/issues/6577
      if (import.meta.env?.PROD && !isProductionWorker(req)) {
        if ('then' in res) {
          res = res.then((res) => removeGzipEncoding(res))
        } else {
          res = removeGzipEncoding(res)
        }
      }
      return res
    }

    return {
      fetch: fetchFn,
      build: async (utils) => {
        const server = await startPreviewServer()
        // Fallback middleware for the case without `@cloudflare/vite-plugin`.
        server.middlewares.use(async (_req, res, next) => {
          try {
            const { Readable } = await import(/* @vite-ignore */ DO_NOT_BUNDLE + 'node:stream')
            Readable.fromWeb(buildBody()).pipe(res)
          } catch (err) {
            next(err)
          }
        })
        const response = await fetch(server.baseUrl + internalPathToBuildStaticFiles, {
          headers: { connection: 'close' },
        })
        if (!response.body) throw new Error('Preview server returned an empty build stream.')
        await consumeMultiplexedStream(response.body, async (key, stream) => {
          if (key.startsWith(PRUNABLE_KEY_PREFIX)) {
            utils.unstable_registerPrunableFile(key.slice(PRUNABLE_KEY_PREFIX.length))
            return
          }
          await utils.emitFile(key, stream)
        })
        // https://github.com/nodejs/node/issues/56645
        await new Promise((resolve) => setTimeout(resolve, 100))
        await server.close()
      },
      buildOptions,
      buildEnhancers: [vocsCloudflareBuildEnhancer],
      defaultExport: {
        ...options?.handlers,
        fetch(req: Request, env: Readonly<Record<string, unknown>>) {
          setAllEnv(env)
          return fetchFn(req)
        },
      },
    }
  },
)

export default adapter
