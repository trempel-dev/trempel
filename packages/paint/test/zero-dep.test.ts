/**
 * Zero-dependency guard: no dependencies or peer dependencies, and the
 * sources import nothing but their own files (relative paths). Browser APIs
 * only — no framework, no renderer, no other package of this monorepo.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(import.meta.dirname, '..')

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    return statSync(p).isDirectory() ? files(p) : /\.ts$/.test(name) ? [p] : []
  })
}

describe('zero dependencies', () => {
  it('package.json has no dependencies or peerDependencies', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as Record<string, unknown>
    expect(pkg.dependencies ?? {}).toEqual({})
    expect(pkg.peerDependencies ?? {}).toEqual({})
    expect(pkg.optionalDependencies ?? {}).toEqual({})
  })

  it('sources import only relative files', () => {
    const re = /(?:^|\s)(?:import|export)\s[^'"`]*?from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|^\s*import\s+['"]([^'"]+)['"]/gm
    const bad: string[] = []
    for (const file of files(join(ROOT, 'src'))) {
      const code = readFileSync(file, 'utf8')
      for (const m of code.matchAll(re)) {
        const spec = m[1] ?? m[2] ?? m[3]!
        if (!spec.startsWith('./') && !spec.startsWith('../')) bad.push(`${file}: ${spec}`)
      }
    }
    expect(bad).toEqual([])
  })
})
