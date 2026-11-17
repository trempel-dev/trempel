import { describe, expect, it } from 'vitest'
import { createHttpGenerator, describeHttpGenerator } from '../src/http.js'

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])
const io = { signal: new AbortController().signal, progress: () => undefined }

describe('createHttpGenerator', () => {
  it('posts multipart fields and reads JSON images', async () => {
    let form: FormData | null = null
    const gen = createHttpGenerator({
      url: 'http://x/gen',
      headers: { 'x-k': '1' },
      fetch: async (_url, init) => {
        form = init!.body as FormData
        expect((init!.headers as Record<string, string>)['x-k']).toBe('1')
        return new Response(JSON.stringify({ images: [Buffer.from(PNG).toString('base64'), `data:image/png;base64,${Buffer.from(PNG).toString('base64')}`] }), { headers: { 'content-type': 'application/json' } })
      },
    })
    const out = await gen.run({ image: new Blob([PNG]), mask: new Blob([PNG]), prompt: 'eyes closed', denoise: 0.4, seed: 7, n: 2, params: { steps: 20 } }, io)
    expect(out).toHaveLength(2)
    expect(out[0]!.type).toBe('image/png')
    expect(form!.get('prompt')).toBe('eyes closed')
    expect(form!.get('denoise')).toBe('0.4')
    expect(form!.get('seed')).toBe('7')
    expect(form!.get('n')).toBe('2')
    expect(JSON.parse(String(form!.get('params')))).toEqual({ steps: 20 })
    expect(form!.get('mask')).toBeInstanceOf(Blob)
  })

  it('reads image/* and multipart/mixed responses, surfaces errors', async () => {
    const one = createHttpGenerator({ url: 'u', fetch: async () => new Response(PNG, { headers: { 'content-type': 'image/png' } }) })
    expect(await one.run({ image: new Blob([PNG]), prompt: '' }, io)).toHaveLength(1)

    const b = 'XyZ'
    const body = Buffer.concat([
      Buffer.from(`--${b}\r\ncontent-type: image/png\r\n\r\n`),
      Buffer.from(PNG),
      Buffer.from(`\r\n--${b}\r\ncontent-type: image/png\r\n\r\n`),
      Buffer.from(PNG),
      Buffer.from(`\r\n--${b}--\r\n`),
    ])
    const many = createHttpGenerator({ url: 'u', fetch: async () => new Response(body, { headers: { 'content-type': `multipart/mixed; boundary=${b}` } }) })
    const imgs = await many.run({ image: new Blob([PNG]), prompt: '' }, io)
    expect(imgs).toHaveLength(2)
    expect(new Uint8Array(await imgs[1]!.arrayBuffer())).toEqual(PNG)

    const bad = createHttpGenerator({ url: 'u', fetch: async () => new Response(JSON.stringify({ error: 'no model' }), { status: 500 }) })
    await expect(bad.run({ image: new Blob([PNG]), prompt: '' }, io)).rejects.toThrow('no model')
  })

  it('describes itself from GET', async () => {
    const gen = await describeHttpGenerator({ url: 'u', fetch: async () => new Response(JSON.stringify({ id: 'sd', label: 'SD', caps: { mask: false, multiple: 64 } })) })
    expect(gen.id).toBe('sd')
    expect(gen.caps).toMatchObject({ mask: false, denoise: true, multiple: 64 })
  })
})
