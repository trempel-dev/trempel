// Release builds ship rasters without metadata (ComfyUI workflow / prompt in PNG text chunks,
// EXIF / XMP, C2PA) — no re-encoding, the decoded pixels are bit-identical; the gate fails on
// anything left and on generation sidecars (E_ASSET_METADATA).
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32 } from 'node:zlib';
import sharp from 'sharp';
import { build } from 'vite';
import { describe, expect, it, vi } from 'vitest';
import { cleanAssets, isPng, scanMetadata, stripImage, stripJpeg, stripPng, stripWebp } from '../src/vite/metadata.js';
import { trempelKit } from '../src/vite/index.js';

const W = 24;
const H = 16;
const pixels = Buffer.from(Array.from({ length: W * H * 4 }, (_, i) => (i * 37 + (i >> 4) * 11) & 0xff));
const raw = (b: Uint8Array) => sharp(b).ensureAlpha().raw().toBuffer();

/** A PNG chunk with its CRC. */
function chunk(type: string, data: Uint8Array | string): Buffer {
  const body = Buffer.from(data);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(body.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), body]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

const WORKFLOW = JSON.stringify({ last_node_id: 9, nodes: [{ id: 3, type: 'KSampler', widgets_values: [42, 'fixed', 20, 7, 'euler'] }] });
const PROMPT = JSON.stringify({ '6': { class_type: 'CLIPTextEncode', inputs: { text: 'a cute cat, game art, secret style words' } } });

/** What ComfyUI writes: tEXt prompt + workflow after IHDR; plus iTXt, zTXt, tIME, a C2PA caBX and an eXIf. */
async function comfyPng(): Promise<Buffer> {
  const png = await sharp(pixels, { raw: { width: W, height: H, channels: 4 } }).png().toBuffer();
  const ihdrEnd = 8 + 12 + png.readUInt32BE(8);
  const tiff = Buffer.from([0x4d, 0x4d, 0, 42, 0, 0, 0, 8, 0, 1, 0x01, 0x0e, 0, 2, 0, 0, 0, 4, 0x61, 0x62, 0x63, 0]); // ImageDescription
  return Buffer.concat([
    png.subarray(0, ihdrEnd),
    chunk('tEXt', `prompt\0${PROMPT}`),
    chunk('tEXt', `workflow\0${WORKFLOW}`),
    chunk('iTXt', 'parameters\0\0\0\0\0steps: 20'),
    chunk('zTXt', Buffer.from([0x43, 0x6f, 0, 0, 0x78, 0x9c, 0x03, 0, 0, 0, 0, 1])),
    chunk('tIME', Buffer.from([7, 234, 10, 5, 12, 0, 0])),
    chunk('caBX', 'jumb c2pa manifest'),
    chunk('eXIf', tiff),
    png.subarray(ihdrEnd),
  ]);
}

const pngChunks = (b: Uint8Array): string[] => {
  const out: string[] = [];
  const v = Buffer.from(b);
  for (let at = 8; at + 12 <= v.length; at += 12 + v.readUInt32BE(at)) out.push(v.toString('latin1', at + 4, at + 8));
  return out;
};

describe('metadata: stripping without re-encoding', () => {
  it('PNG with a ComfyUI workflow in tEXt: every metadata chunk goes, the pixels are bit-identical', async () => {
    const src = await comfyPng();
    expect(Buffer.from(src).includes('KSampler')).toBe(true);
    const s = stripPng(src);
    expect(s.removed).toEqual(['tEXt', 'tEXt', 'iTXt', 'zTXt', 'tIME', 'caBX', 'eXIf']);
    expect(pngChunks(s.data).filter((c) => c !== 'IDAT')).toEqual(['IHDR', 'pHYs', 'IEND']);
    for (const word of ['KSampler', 'CLIPTextEncode', 'workflow', 'prompt', 'c2pa', 'steps']) expect(Buffer.from(s.data).includes(word)).toBe(false);
    expect((await raw(s.data)).equals(await raw(src))).toBe(true);
    expect((await raw(s.data)).equals(pixels)).toBe(true);
    // Already clean: the same bytes back.
    expect(stripPng(s.data).removed).toEqual([]);
  });

  it('JPEG: EXIF, XMP, IPTC, C2PA JUMBF and comments go; JFIF, ICC and the scan stay byte for byte', async () => {
    const jpg = await sharp(pixels, { raw: { width: W, height: H, channels: 4 } })
      .jpeg({ quality: 90 })
      .withMetadata({ exif: { IFD0: { ImageDescription: 'secret prompt' } } })
      .withIccProfile('srgb')
      .toBuffer();
    const seg = (marker: number, body: string) => {
      const b = Buffer.from(body, 'latin1');
      return Buffer.concat([Buffer.from([0xff, marker, (b.length + 2) >> 8, (b.length + 2) & 0xff]), b]);
    };
    const src = Buffer.concat([jpg.subarray(0, 2), seg(0xe1, 'http://ns.adobe.com/xap/1.0/\0<x:xmpmeta>prompt</x:xmpmeta>'), seg(0xeb, 'JP\0\0jumbc2pa'), seg(0xed, 'Photoshop 3.0\0'), seg(0xfe, 'made with a model'), jpg.subarray(2)]);
    const s = stripJpeg(src);
    expect(s.removed.sort()).toEqual(['APP1 Exif', 'APP1 XMP', 'APP11 JUMBF', 'APP13 IPTC', 'COM'].sort());
    const out = Buffer.from(s.data);
    for (const word of ['secret prompt', 'xmpmeta', 'c2pa', 'made with', 'Exif\0\0']) expect(out.includes(word)).toBe(false);
    expect(out.includes('ICC_PROFILE')).toBe(true);
    expect((await raw(s.data)).equals(await raw(src))).toBe(true);
    // The entropy-coded data after SOS is untouched.
    const sos = (b: Buffer) => b.subarray(b.indexOf(Buffer.from([0xff, 0xda])));
    expect(sos(out).equals(sos(src))).toBe(true);
  });

  it('WebP: EXIF / XMP / C2PA chunks go, VP8X flags and the RIFF size follow', async () => {
    const src = await sharp(pixels, { raw: { width: W, height: H, channels: 4 } })
      .webp({ lossless: true })
      .withMetadata({ exif: { IFD0: { ImageDescription: 'secret prompt' } } })
      .toBuffer();
    const withC2pa = Buffer.concat([src, Buffer.from('C2PA', 'latin1'), Buffer.from([4, 0, 0, 0]), Buffer.from('jumb')]);
    withC2pa.writeUInt32LE(withC2pa.length - 8, 4);
    const s = stripWebp(withC2pa);
    expect(s.removed).toContain('EXIF');
    expect(s.removed).toContain('C2PA');
    const out = Buffer.from(s.data);
    expect(out.includes('secret prompt')).toBe(false);
    expect(out.readUInt32LE(4)).toBe(out.length - 8);
    if (out.toString('latin1', 12, 16) === 'VP8X') expect(out[20] & 0x0c).toBe(0);
    expect((await raw(s.data)).equals(await raw(src))).toBe(true);
    expect((await raw(s.data)).equals(pixels)).toBe(true);
  });

  it('an EXIF orientation is not dropped (the image would turn): cleanAssets leaves it, the gate fails', async () => {
    const dist = mkdtempSync(join(tmpdir(), 'kit-meta-orient-'));
    const turned = await sharp(pixels, { raw: { width: W, height: H, channels: 4 } }).jpeg().withMetadata({ orientation: 6 }).toBuffer();
    expect(stripImage(turned)?.orientation).toBe(6);
    writeFileSync(join(dist, 'photo.jpg'), turned);
    expect(cleanAssets(dist).cleaned).toEqual([]);
    expect(scanMetadata(dist)).toEqual([{ file: 'photo.jpg', what: expect.stringMatching(/orientation 6/) }]);
  });
});

describe('metadata gate', () => {
  it('cleanAssets rewrites the dist in place; then the gate is clean', async () => {
    const dist = mkdtempSync(join(tmpdir(), 'kit-meta-'));
    mkdirSync(join(dist, 'assets'));
    const src = await comfyPng();
    writeFileSync(join(dist, 'assets', 'cat.png'), src);
    writeFileSync(join(dist, 'assets', 'levels.json'), JSON.stringify({ levels: [1, 2] }));
    expect(scanMetadata(dist).map((h) => h.file)).toEqual(['assets/cat.png']);
    const r = cleanAssets(dist);
    expect(r.rasters).toBe(1);
    expect(r.cleaned.map((c) => c.file)).toEqual(['assets/cat.png']);
    expect(r.bytesBefore - r.bytesAfter).toBeGreaterThan(WORKFLOW.length);
    expect(scanMetadata(dist)).toEqual([]);
    expect((await raw(readFileSync(join(dist, 'assets', 'cat.png')))).equals(pixels)).toBe(true);
  });

  it.each([
    ['assets/cat.png.json', '{}'],
    ['assets/cat.webp.json', '{}'],
    ['gen/run.json', JSON.stringify({ prompt: { '3': {} } })],
    ['gen/flow.json', JSON.stringify({ workflow: {}, x: 1 })],
  ])('a generation sidecar %s fails the gate', (file, text) => {
    const dist = mkdtempSync(join(tmpdir(), 'kit-meta-side-'));
    mkdirSync(join(dist, file, '..'), { recursive: true });
    writeFileSync(join(dist, file), text);
    expect(scanMetadata(dist).map((h) => h.file)).toEqual([file]);
  });

  it('other rasters (GIF, AVIF) are checked by markers', () => {
    const dist = mkdtempSync(join(tmpdir(), 'kit-meta-gif-'));
    writeFileSync(join(dist, 'a.gif'), Buffer.concat([Buffer.from('GIF89a'), Buffer.from('XMP DataXMP<x:xmpmeta>')]));
    writeFileSync(join(dist, 'b.gif'), Buffer.from('GIF89a plain'));
    expect(scanMetadata(dist)).toEqual([{ file: 'a.gif', what: 'XMP' }]);
  });
});

describe('metadata: the kit plugin in a real vite build', () => {
  async function project(extra: (root: string) => void = () => {}): Promise<string> {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'kit-meta-build-')));
    writeFileSync(join(root, 'index.html'), '<!doctype html><html><head></head><body><script type="module" src="./main.js"></script></body></html>');
    writeFileSync(join(root, 'main.js'), "import cat from './cat.png';\ndocument.body.dataset.cat = cat;\n");
    writeFileSync(join(root, 'cat.png'), await comfyPng());
    extra(root);
    return root;
  }
  const run = (root: string, mode = 'web') => build({ root, mode, logLevel: 'silent', configFile: false, plugins: [trempelKit()] });

  it('web build: the ComfyUI PNG ships without its chunks, pixels the same', async () => {
    const root = await project();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await run(root);
    log.mockRestore();
    const dir = join(root, 'dist-web', 'assets');
    const { readdirSync } = await import('node:fs');
    const png = readdirSync(dir).find((f) => f.endsWith('.png'))!;
    const out = readFileSync(join(dir, png));
    expect(isPng(out)).toBe(true);
    expect(pngChunks(out).filter((c) => c !== 'IDAT')).toEqual(['IHDR', 'pHYs', 'IEND']);
    expect(out.includes('KSampler')).toBe(false);
    expect((await raw(out)).equals(pixels)).toBe(true);
    expect(scanMetadata(join(root, 'dist-web'))).toEqual([]);
  }, 60_000);

  it('a sidecar among the assets (public/cat.png.json): the build fails with E_ASSET_METADATA and the file', async () => {
    const root = await project((r) => {
      mkdirSync(join(r, 'public'));
      writeFileSync(join(r, 'public', 'cat.png.json'), JSON.stringify({ prompt: PROMPT, workflow: WORKFLOW }));
    });
    await expect(run(root)).rejects.toThrow(/E_ASSET_METADATA[\s\S]*cat\.png\.json/);
  }, 60_000);
});
