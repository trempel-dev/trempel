# @trempel/paint

Zero-dependency image editor for generative edits — fix a face, a hand or a
detail, or make sprite states (eyes closed, wink, mouth open) — without a node
graph in front of you.

- DOM + Canvas 2D only, no framework, no dependencies; works in any page.
- Canvas with pan/zoom (wheel, space+drag, pinch), fit / 1:1, **pixel mode**
  (nearest neighbour, pixel grid when zoomed in).
- Mask tools: brush (size, hardness), eraser, lasso (free or polygon),
  rectangle, invert, clear, undo/redo.
- **Inpaint only masked**: the mask bbox plus padding is cropped, scaled to the
  model's working resolution (multiple of 8/64), generated with the mask and a
  low denoise, scaled back and pasted by the mask with an inward feather.
  Small images (sprites) are scaled up the same way.
- Generation is a pluggable **adapter** (`Generator`); the editor knows nothing
  about providers. One adapter ships: `createHttpGenerator` (a plain HTTP
  contract, below).
- **Layers as patches** over the base, a **series** of states (one mask,
  several prompts, fixed seed), before/after, export of layers with a neutral
  manifest.

```sh
npm install @trempel/paint
```

## Quick start

```ts
import { createImageEditor, createHttpGenerator } from '@trempel/paint'

const editor = createImageEditor(document.querySelector('#editor')!, {
  image: await (await fetch('/portrait.png')).blob(),
  generators: [createHttpGenerator({ url: '/api/inpaint' })],
  presets: [{ id: 'face', label: 'Face', values: { denoise: 0.4, padding: 32, workSide: 1024, feather: 8 } }],
  actions: [{ id: 'save', label: 'Save', run: async (ed) => upload(await ed.export()) }],
})
await editor.ready
// …
const { base, layers, manifest } = await editor.exportLayers()
editor.destroy()
```

The container should have a size (the editor fills it). Theme it with CSS
variables on the container or any ancestor: `--paint-bg`, `--paint-surface`,
`--paint-fg`, `--paint-muted`, `--paint-line`, `--paint-accent`,
`--paint-error`, `--paint-font`, `--paint-radius`. UI strings: `labels`
(English by default). React/Vue wrappers are a few lines on top of
`createImageEditor` / `destroy`.

Keys (when the pointer or focus is over the editor): `B` brush, `E` eraser,
`L` lasso, `M` rectangle, `F` region, `[` `]` brush size, `⌘Z` / `⇧⌘Z`
undo/redo, `0` fit, `1` 1:1, `P` pixel mode, hold `\` — before, `←` `→`
layers, space+drag — pan, `Enter` / double-click — close a polygon lasso.

## Generator adapter

```ts
interface Generator {
  id: string
  label: string
  caps: {
    mask: boolean        // inpaint: the mask is sent; false — instruction edit, the mask stays local
    denoise: boolean
    negative: boolean
    refs?: number        // extra reference images accepted
    maxSide?: number     // caps the working resolution
    multiple?: number    // working size multiple (default 8)
    variants?: number    // candidates per run (panel offers 1…variants, default 4)
  }
  params?: ParamField[]  // extra fields of the adapter (model, template, steps…): a simple form
  run(req: {
    image: Blob          // working-size crop, PNG; transparency flattened onto the backdrop
    mask?: Blob          // same size, PNG, white = edit (only when caps.mask)
    refs?: Blob[]
    prompt: string
    negative?: string
    denoise?: number
    seed?: number
    n?: number
    params?: Record<string, unknown>
  }, io: {
    signal: AbortSignal
    progress(p: { value?: number; preview?: Blob; text?: string }): void
  }): Promise<Blob[]>
}

interface Matter { matte(image: Blob, io: { signal: AbortSignal }): Promise<Blob> }
```

The panel is built from `caps`: with `mask` the edit is an inpaint; without it
the generator gets the crop (or the whole image when nothing is masked) and
the result is still pasted back only where the mask is. `denoise` and
`negative` fields appear only when the adapter takes them.

Never put vendor API keys in the browser: put the vendor behind an endpoint
(see below) or behind your own adapter that talks to your backend.

## HTTP generator

`createHttpGenerator({ url, headers?, id?, label?, caps?, params? })` posts
`multipart/form-data` to `url`:

| field | |
|---|---|
| `image` | PNG, the working-size crop |
| `mask` | PNG, optional, white = edit |
| `ref` | PNG, 0…n (repeated field) |
| `prompt` | text |
| `negative`, `denoise`, `seed`, `n` | text, optional |
| `params` | JSON object — the adapter fields |

The response is one of:

- `200 image/*` — one image;
- `200 multipart/mixed; boundary=…` — several images, one per part;
- `200 application/json` — `{ "images": ["<base64 or data: URL>", …] }`;
- an error status — `{ "error": "message" }` or plain text, thrown as the message.

`describeHttpGenerator({ url })` builds the generator from `GET <url>`
returning `{ id?, label?, caps?, params? }`.

## Geometry (pure functions)

```ts
planCrop(maskBBox, padding, imageSize, targetLongSide, multiple?) → CropPlan
// { x, y, w, h } — crop in source pixels, inside the image (slides inward at the edge)
// { workW, workH } — working size, multiples of `multiple`, long side ≈ target
// scale — workW / w (above 1: scaled up)

cropScaled(base, plan, { background? })   → Raster   // opaque, transparency on the backdrop
maskScaled(mask, plan)                    → Raster   // white on black
pasteBack(base, result, mask, plan, { feather?, colorMatch?, alpha?, matte? }) → Raster
```

`pasteBack` copies every pixel where the (feathered) mask is zero byte for
byte; the feather goes inward only. Alpha: models do not keep transparency, so

- `alpha: 'keep'` — the source alpha (default for images with transparency;
  fully transparent source pixels stay untouched);
- `alpha: 'result'` — the result's alpha (default for opaque images);
- `alpha: 'matte'` — the alpha of a matted result (pass `matte`, or give the
  editor a `Matter`).

The backdrop used for the crop never reaches the result.

`Raster` is `{ width, height, data: Uint8ClampedArray }` (RGBA, straight
alpha — the shape of `ImageData`), `MaskData` is one byte per pixel.
`encodePng` writes PNG bytes exactly (no canvas premultiplication).

## Layers and export

A layer is a patch `{ name, bbox, rgba }`: its pixels **replace** the base
inside `bbox`. Generate a candidate, pick it, “Use as layer”; or run a
**series** — one line per state (`eyes closed: closed eyes, …`), one mask, a
fixed seed — and get a layer per state. `←` `→` flip through them; hold `\`
for the base. “Apply and keep editing” bakes a layer into the base.

`editor.export()` — flattened PNG of what is shown (base + active layer).
`editor.exportLayers()`:

```ts
{
  base: Blob,                                   // PNG
  layers: [{ name, file, x, y, w, h, png }],    // png: Blob
  manifest: {
    format: 'trempel-paint-layers', version: 1,
    width, height,
    base: 'base.png',
    layers: [{ name, file: 'layers/<slug>.png', x, y, w, h, mode: 'replace' }]
  }
}
```

Write `manifest` as `manifest.json` next to `base.png` and `layers/`.
`editor.chain()` returns the records of the applied edits plus the active
layer (`generator`, `prompt`, `denoise`, `seed`, `params`, `plan`, `feather`,
`alpha`) — enough to describe how the image was made.

## License

MIT © Denys Vynohradskyi
