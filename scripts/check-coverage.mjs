#!/usr/bin/env node
// Fails if any of the given source files is below the line-coverage threshold in an lcov report.
// Usage: node scripts/check-coverage.mjs <lcov.info> <minPercent> <file...>
import { readFileSync } from 'node:fs'

const [lcovPath, minRaw, ...files] = process.argv.slice(2)
if (!lcovPath || !minRaw || files.length === 0) {
  console.error('usage: check-coverage.mjs <lcov.info> <minPercent> <file...>')
  process.exit(2)
}

const min = Number(minRaw)
const lcov = readFileSync(lcovPath, 'utf8')

/** @type {Map<string, {hit: number, found: number}>} */
const coverage = new Map()
let current = null
for (const line of lcov.split(/\r?\n/)) {
  if (line.startsWith('SF:')) {
    current = line.slice(3).replaceAll('\\', '/')
    coverage.set(current, { hit: 0, found: 0 })
  } else if (current && line.startsWith('LH:')) {
    coverage.get(current).hit = Number(line.slice(3))
  } else if (current && line.startsWith('LF:')) {
    coverage.get(current).found = Number(line.slice(3))
  }
}

let failed = false
for (const file of files) {
  const key = [...coverage.keys()].find((k) => k.endsWith(file.replaceAll('\\', '/')))
  if (!key) {
    console.error(`✗ ${file}: not found in ${lcovPath}`)
    failed = true
    continue
  }
  const { hit, found } = coverage.get(key)
  const pct = found === 0 ? 100 : (hit / found) * 100
  const ok = pct >= min
  console.log(`${ok ? '✓' : '✗'} ${file}: ${pct.toFixed(2)}% lines (${hit}/${found})`)
  if (!ok) failed = true
}

if (failed) {
  console.error(`\nLine coverage below ${min}%.`)
  process.exit(1)
}
console.log(`\nAll listed contracts meet the ${min}% line-coverage floor.`)
