/**
 * The one adapter shipped with the package: a plain HTTP contract any server
 * can implement (README, "HTTP generator"). Vendor adapters do not live here —
 * API keys must never reach the browser; put them behind such an endpoint.
 *
 *   POST <url>   multipart/form-data
 *     image      PNG (working-size crop)
 *     mask       PNG (optional, white = edit)
 *     ref        PNG (0…n, repeated)
 *     prompt, negative?, denoise?, seed?, n?   text fields
 *     params     JSON object (adapter fields)
 *   → 200 image/*            one image
 *   → 200 multipart/mixed    several images (one per part)
 *   → 200 application/json   { "images": ["<base64>", …] }  (or data: URLs)
 *   → 4xx/5xx                { "error": "…" } or text — becomes the thrown message
 *
 * `GET <url>` (optional) may describe the adapter: `{ id?, label?, caps?, params? }`
 * — see `describeHttpGenerator`.
 */

import type { Generator, GeneratorCaps, ParamField } from './types.js'

export interface HttpGeneratorOptions {
  url: string
  headers?: Record<string, string>
  id?: string
  label?: string
  caps?: Partial<GeneratorCaps>
  params?: ParamField[]
  /** Custom fetch (tests, auth wrappers). */
  fetch?: typeof fetch
}

function fromBase64(b64: string): Uint8Array {
  const clean = b64.replace(/^data:[^,]*,/, '')
  const bin = atob(clean)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i)
  return out
}

function mimeOf(b: Uint8Array): string {
  if (b[0] === 0x89 && b[1] === 0x50) return 'image/png'
  if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg'
  if (b[0] === 0x52 && b[1] === 0x49) return 'image/webp'
  return 'application/octet-stream'
}

/** Split a `multipart/mixed` body into its part bodies. */
async function multipartImages(res: Response, boundary: string): Promise<Blob[]> {
  const body = new Uint8Array(await res.arrayBuffer())
  const sep = new TextEncoder().encode(`--${boundary}`)
  const find = (from: number): number => {
    outer: for (let i = from; i <= body.length - sep.length; i += 1) {
      for (let k = 0; k < sep.length; k += 1) if (body[i + k] !== sep[k]) continue outer
      return i
    }
    return -1
  }
  const out: Blob[] = []
  let at = find(0)
  while (at !== -1) {
    const next = find(at + sep.length)
    if (next === -1) break
    const part = body.subarray(at + sep.length, next)
    // headers end at the first blank line
    let split = -1
    for (let i = 0; i + 3 < part.length; i += 1) {
      if (part[i] === 13 && part[i + 1] === 10 && part[i + 2] === 13 && part[i + 3] === 10) {
        split = i + 4
        break
      }
    }
    if (split !== -1) {
      let end = part.length
      if (part[end - 2] === 13 && part[end - 1] === 10) end -= 2
      const bytes = part.slice(split, end)
      if (bytes.length > 0) out.push(new Blob([bytes as BlobPart], { type: mimeOf(bytes) }))
    }
    at = next
  }
  return out
}

async function errorText(res: Response): Promise<string> {
  const text = await res.text().catch(() => '')
  try {
    const j = JSON.parse(text) as { error?: unknown }
    if (typeof j.error === 'string') return j.error
  } catch {
    // plain text
  }
  return text.trim() || `HTTP ${res.status}`
}

export function createHttpGenerator(opts: HttpGeneratorOptions): Generator {
  const doFetch = opts.fetch ?? fetch
  return {
    id: opts.id ?? 'http',
    label: opts.label ?? 'HTTP',
    caps: { mask: true, denoise: true, negative: true, ...opts.caps },
    ...(opts.params ? { params: opts.params } : {}),
    async run(req, io) {
      const form = new FormData()
      form.append('image', req.image, 'image.png')
      if (req.mask) form.append('mask', req.mask, 'mask.png')
      for (const [i, ref] of (req.refs ?? []).entries()) form.append('ref', ref, `ref${i + 1}.png`)
      form.append('prompt', req.prompt)
      if (req.negative !== undefined) form.append('negative', req.negative)
      if (req.denoise !== undefined) form.append('denoise', String(req.denoise))
      if (req.seed !== undefined) form.append('seed', String(req.seed))
      if (req.n !== undefined) form.append('n', String(req.n))
      form.append('params', JSON.stringify(req.params ?? {}))
      io.progress({ text: 'sending' })
      const res = await doFetch(opts.url, { method: 'POST', body: form, signal: io.signal, ...(opts.headers ? { headers: opts.headers } : {}) })
      if (!res.ok) throw new Error(await errorText(res))
      const type = res.headers.get('content-type') ?? ''
      let images: Blob[]
      if (type.startsWith('image/')) images = [await res.blob()]
      else if (type.startsWith('multipart/')) {
        const boundary = /boundary="?([^";]+)"?/i.exec(type)?.[1]
        if (!boundary) throw new Error('http generator: multipart without boundary')
        images = await multipartImages(res, boundary)
      } else {
        const j = (await res.json()) as { images?: unknown; error?: unknown }
        if (typeof j.error === 'string') throw new Error(j.error)
        if (!Array.isArray(j.images)) throw new Error('http generator: expected { images: [...] }')
        images = j.images.filter((s): s is string => typeof s === 'string').map((s) => {
          const bytes = fromBase64(s)
          return new Blob([bytes as BlobPart], { type: mimeOf(bytes) })
        })
      }
      if (images.length === 0) throw new Error('http generator: no images in the response')
      io.progress({ value: 1 })
      return images
    },
  }
}

/** Build a generator from the endpoint's own description (`GET <url>`). */
export async function describeHttpGenerator(opts: HttpGeneratorOptions): Promise<Generator> {
  const doFetch = opts.fetch ?? fetch
  const res = await doFetch(opts.url, { method: 'GET', ...(opts.headers ? { headers: opts.headers } : {}) })
  if (!res.ok) throw new Error(await errorText(res))
  const d = (await res.json()) as { id?: string; label?: string; caps?: Partial<GeneratorCaps>; params?: ParamField[] }
  return createHttpGenerator({
    ...opts,
    ...(d.id ? { id: d.id } : {}),
    ...(d.label ? { label: d.label } : {}),
    caps: { ...d.caps, ...opts.caps },
    ...(d.params || opts.params ? { params: opts.params ?? d.params ?? [] } : {}),
  })
}
