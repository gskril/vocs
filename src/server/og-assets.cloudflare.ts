/// <reference types="vite/client" />

// Cloudflare-only variant of `og-assets.ts`, swapped in for the `rsc`/`ssr`
// server environments by the `cloudflareRuntime()` plugin (via a resolveId
// redirect of the `import.meta.glob('./og-assets.{js,ts}')` trampoline in
// `handlers.ts`). Node/Vercel/Netlify keep using the unmodified `og-assets.ts`.
//
// workerd forbids compiling WebAssembly from bytes at runtime, so the
// Node/Vercel path (fetch the `?url` asset, pass the ArrayBuffer to
// `ImageResponse`) cannot work here. Instead the `.wasm` is uploaded as a
// CompiledWasm module (via Wrangler's default `.wasm` rule) and imported
// relative to this chunk, which yields a precompiled
// `WebAssembly.Module` as the default export.

export { ImageResponse } from '@takumi-rs/image-response/wasm'

// `?url` emits the wasm into the server bundle (`dist/server/assets/`) and gives
// its hashed, chunk-relative filename. The runtime `import()` of that relative
// specifier resolves against the uploaded module graph — workerd returns
// `{ default: WebAssembly.Module }`, which `ImageResponse`'s `module` option
// awaits and unwraps.
import wasmUrl from '@takumi-rs/wasm/takumi_wasm_bg.wasm?url'
import font from './fonts/geist.woff2?arraybuffer'

// A `Promise<{ default: WebAssembly.Module }>` — the exact shape
// `@takumi-rs/image-response/wasm` accepts for its `module` option. `handlers.ts`
// forwards a non-string `wasm` straight through instead of fetching it.
export const wasm = import(/* @vite-ignore */ `./${wasmUrl.split('/').pop()}`)

export { font }
