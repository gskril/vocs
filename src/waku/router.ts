import { router as internalRouter } from './internal/patches/router.js'

/**
 * Creates the Vocs router for a custom Waku server entry.
 *
 * Custom entries cannot use the generated build-time OpenAPI boundary, so keep
 * the historical behavior and load OpenAPI support through the public wrapper.
 * Managed entries import the internal router directly and only provide this
 * loader when OpenAPI is configured.
 */
export function router(
  ...args: Parameters<typeof internalRouter>
): ReturnType<typeof internalRouter> {
  const [modules, options] = args
  return internalRouter(modules, {
    ...options,
    loadOpenapi: options?.loadOpenapi ?? (() => import('./internal/openapi.js')),
  })
}
