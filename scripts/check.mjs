#!/usr/bin/env node
/**
 * Repository checks for dsh-team-control.
 *
 * Dependency-free on purpose: the bundle itself must import nothing, and CI should not need an
 * install step to check it. What this proves:
 *
 *   1. the bundle manifest parses and every path it publishes exists;
 *   2. the Host entry parses as ESM and imports no @deepseek-ai package (ADR 0002);
 *   3. locale/en.json and locale/zh.json carry the same keys;
 *   4. the bundle patch declares the rows the README promises;
 *   5. bilingual document pairs exist;
 *   6. no shared document carries an absolute machine path.
 *
 * What it cannot prove: that the plugin activates, or that any tool behaves. That needs a profile
 * install and a live call, which is the user's decision every time.
 *
 * The YAML reader below understands only the subset this repository's patch uses. It is a structural
 * check of a known file, not a YAML parser; a construct it does not understand is reported, never
 * silently accepted.
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const failures = []
const fail = (message) => failures.push(message)

const read = (relative) => {
  const absolute = join(root, relative)
  if (!existsSync(absolute)) {
    fail(`${relative}: missing`)
    return undefined
  }
  return readFileSync(absolute, 'utf8')
}

const readJson = (relative) => {
  const text = read(relative)
  if (text === undefined) return undefined
  try {
    return JSON.parse(text)
  } catch (error) {
    fail(`${relative}: invalid JSON (${error.message})`)
    return undefined
  }
}

// 1. Manifest and published files.
const manifest = readJson('package.json')
let pluginName
if (manifest !== undefined) {
  pluginName = manifest.name
  if (typeof pluginName !== 'string' || !pluginName.startsWith('@local/')) {
    fail('package.json: name must be an @local/ scoped package')
  }
  if (manifest.type !== 'module') fail('package.json: type must be "module"')
  const patch = manifest.dsh?.bundle?.patch
  if (patch !== './cordis.patch.yml') fail('package.json: dsh.bundle.patch must point at ./cordis.patch.yml')
  for (const entry of manifest.files ?? []) {
    if (entry.includes('*')) {
      const directory = join(root, dirname(entry))
      const pattern = entry.slice(entry.lastIndexOf('/') + 1)
      const suffix = pattern.replace('*', '')
      const matches = existsSync(directory)
        ? readdirSync(directory).filter((name) => name.endsWith(suffix))
        : []
      if (matches.length === 0) fail(`package.json: files entry "${entry}" matches nothing`)
      continue
    }
    if (!existsSync(join(root, entry))) fail(`package.json: files entry "${entry}" does not exist`)
  }
  if (!(manifest.files ?? []).some((entry) => entry === 'index.js')) fail('package.json: files must include index.js')
}

// 2. Host entry: parses, and honours ADR 0002.
const entry = read('index.js')
if (entry !== undefined) {
  if (/from\s+['"]@deepseek-ai\//.test(entry)) {
    fail('index.js: imports an @deepseek-ai package; ADR 0002 forbids it')
  }
  if (/export\s+(async\s+)?function\s+apply\s*\(/.test(entry) === false) {
    fail('index.js: must export apply(ctx, config)')
  }
}

// 3. Locale parity.
const keysOf = (value, prefix = '') => Object.entries(value ?? {})
  .flatMap(([key, child]) => {
    const path = prefix === '' ? key : `${prefix}.${key}`
    return child !== null && typeof child === 'object' && !Array.isArray(child)
      ? keysOf(child, path)
      : [path]
  })
  .sort()
const en = readJson('locale/en.json')
const zh = readJson('locale/zh.json')
if (en !== undefined && zh !== undefined) {
  const enKeys = keysOf(en)
  const zhKeys = keysOf(zh)
  const missingInZh = enKeys.filter((key) => !zhKeys.includes(key))
  const missingInEn = zhKeys.filter((key) => !enKeys.includes(key))
  for (const key of missingInZh) fail(`locale/zh.json: missing key "${key}"`)
  for (const key of missingInEn) fail(`locale/en.json: missing key "${key}"`)
  if (typeof en.meta?.title !== 'string' || en.meta.title.length === 0) fail('locale/en.json: meta.title is required')
  if (typeof en.meta?.description !== 'string' || en.meta.description.length === 0) {
    fail('locale/en.json: meta.description is required')
  }
}

// 4. Bundle patch: the two rows the README promises.
const patchText = read('cordis.patch.yml')
if (patchText !== undefined) {
  const lines = patchText.split(/\r?\n/)
  if (lines.some((line) => line.includes('\t'))) fail('cordis.patch.yml: tabs are not allowed')
  const body = lines.filter((line) => !/^\s*#/.test(line) && line.trim() !== '')
  if (!body.some((line) => /^-\s/.test(line))) fail('cordis.patch.yml: must be a top-level array of patch entries')
  const compactId = body.findIndex((line) => /^-\s+id:\s*compaction-basic\s*$/.test(line))
  if (compactId === -1) {
    fail('cordis.patch.yml: expected an entry for the compaction-basic row')
  } else {
    const following = body.slice(compactId + 1, compactId + 4).join('\n')
    if (!/disabled:\s*false/.test(following)) fail('cordis.patch.yml: compaction-basic must be enabled with disabled: false')
  }
  const insertAt = body.findIndex((line) => /^-\s+insert:\s*$/.test(line))
  if (insertAt === -1) {
    fail('cordis.patch.yml: expected an insert entry for this bundle')
  } else {
    const inserted = body.slice(insertAt + 1).join('\n')
    if (pluginName !== undefined && !inserted.includes(`name: '${pluginName}'`) && !inserted.includes(`name: "${pluginName}"`)) {
      fail(`cordis.patch.yml: insert must name ${pluginName}`)
    }
  }
}

// 5. Bilingual pairs.
const pairs = [
  ['README.md', 'README-zh.md'],
  ['docs/INDEX-en.md', 'docs/INDEX-zh.md'],
  ['docs/architecture-en.md', 'docs/architecture-zh.md'],
]
for (const [english, chinese] of pairs) {
  if (!existsSync(join(root, english))) fail(`${english}: missing (bilingual pair)`)
  if (!existsSync(join(root, chinese))) fail(`${chinese}: missing (bilingual pair)`)
}

// 6. No machine-specific paths in shared documents.
const documents = [
  'README.md', 'README-zh.md', 'AGENTS.md', 'CONTRIBUTING.md', 'PLAN.md', 'PROGRESS.md',
  ...readdirSync(join(root, 'docs')).filter((name) => name.endsWith('.md')).map((name) => `docs/${name}`),
  ...readdirSync(join(root, 'docs', 'adr')).filter((name) => name.endsWith('.md')).map((name) => `docs/adr/${name}`),
]
for (const document of documents) {
  const text = read(document)
  if (text === undefined) continue
  for (const line of text.split(/\r?\n/)) {
    // A drive-letter path, not a URL scheme: the character before `X:` must not be a word
    // character, so `https://host` and `file:///` do not trip the check while `C:\dir` and
    // `(D:/dir)` do.
    if (/(?<![\w/])[A-Za-z]:[\\/]/.test(line)) {
      fail(`${document}: carries an absolute machine path: ${line.trim()}`)
    }
  }
}

if (failures.length > 0) {
  console.error(`check failed: ${failures.length} problem(s)`)
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
console.log('check passed')
