import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const scannedRoots = ['src', 'test', 'docs', 'scripts', 'README.md', 'AGENTS.md', 'CLAUDE.md']
const forbiddenTerm = ['ci', 'rc', 'le'].join('')
const textExtensions = new Set(['.ts', '.js', '.mjs', '.json', '.md'])

function listTextFiles(path: string): string[] {
  const stat = statSync(path)
  if (stat.isFile()) return shouldScan(path) ? [path] : []
  if (!stat.isDirectory()) return []

  return readdirSync(path, { withFileTypes: true }).flatMap(entry => {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git') return []
    return listTextFiles(join(path, entry.name))
  })
}

function shouldScan(path: string): boolean {
  for (const ext of textExtensions) {
    if (path.endsWith(ext)) return true
  }
  return false
}

test('repository content stays free of extension-vendor-specific fixtures', () => {
  const offenders: string[] = []

  for (const root of scannedRoots) {
    for (const file of listTextFiles(join(repoRoot, root))) {
      const text = readFileSync(file, 'utf8')
      if (text.toLowerCase().includes(forbiddenTerm)) {
        offenders.push(file.slice(repoRoot.length + 1))
      }
    }
  }

  assert.deepEqual(offenders, [])
})
