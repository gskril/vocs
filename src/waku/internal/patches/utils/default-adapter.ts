export const CLOUDFLARE_ADAPTER = 'vocs/waku/internal/patches/adapters/cloudflare'

export const getDefaultAdapter = () =>
  // `CLOUDFLARE=1` (Waku's documented opt-in) and `WORKERS_CI` (Cloudflare
  // Workers Builds CI) take precedence over the Vercel/Netlify auto-detection:
  // a platform is never both, and an explicit `CLOUDFLARE` is a deliberate
  // choice that should win. `CLOUDFLARE_API_TOKEN` (used elsewhere for
  // embeddings) must not trigger this — only the bare activation vars do.
  process.env['CLOUDFLARE'] || process.env['WORKERS_CI']
    ? CLOUDFLARE_ADAPTER
    : process.env['VERCEL']
      ? 'vocs/waku/internal/patches/adapters/vercel'
      : process.env['NETLIFY']
        ? 'waku/adapters/netlify'
        : 'vocs/waku/internal/patches/adapters/node'
