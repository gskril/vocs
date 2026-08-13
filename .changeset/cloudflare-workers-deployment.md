---
'vocs': minor
---

Added first-class Cloudflare Workers deployment: set `CLOUDFLARE=1` at build time and deploy with `wrangler`. Supports `dynamic`, `partial-static`, and `full-static` render strategies, markdown negotiation, MCP page tools, and dynamic OG images. Builds omit the OpenAPI runtime when no OpenAPI specs are configured.
