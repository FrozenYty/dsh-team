#!/usr/bin/env node
/**
 * Repository checks for dsh-team.
 *
 * Dependency-free on purpose: the bundle itself must import nothing, and CI should not need an
 * install step to check it. What this proves:
 *
 *   1. the bundle manifest parses, every path it publishes exists, and every Host module is published;
 *   2. no Host module imports an @deepseek-ai package (ADR 0002);
 *   3. locale/en.json and locale/zh.json carry the same keys;
 *   4. the bundle patch declares the rows the README promises;
 *   5. every document under docs/ is classified by the bilingual-pair rule, and no pair is half-written;
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
  // Either a bare npm name or a scoped one; the bundle id and the patch row must agree with it.
  if (typeof pluginName !== 'string' || !/^(?:@[a-z0-9-]+\/)?[a-z][a-z0-9-]*$/.test(pluginName)) {
    fail('package.json: name must be a lowercase npm package name')
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

// 2. Host half: every published module imports no @deepseek-ai package (ADR 0002), and the entry
//    exports the plugin face. Syntax is checked by `node --check` in CI, not here.
const hostModules = ['index.js', 'actions.js', 'roster.js', 'definitions.js', 'trash.js', 'host-hooks.js']
const publishedFiles = new Set((manifest?.files ?? []).map((entry) => entry.replace(/^\.\//, '')))
for (const module of hostModules) {
  const text = read(module)
  if (text === undefined) continue
  if (!publishedFiles.has(module)) fail(`package.json: files must include "${module}"`)
  if (/from\s+['"]@deepseek-ai\//.test(text)) {
    fail(`${module}: imports an @deepseek-ai package; ADR 0002 forbids it`)
  }
}
const entry = read('index.js')
if (entry !== undefined && !/export\s+(async\s+)?function\s+apply\s*\(/.test(entry)) {
  fail('index.js: must export apply(ctx, config)')
}
// Every tool wrapper takes the host execution context. A signature that omits `exec` while its body
// reads `exec.agent` is a ReferenceError only when the model calls the tool: retired, restored and
// stopped members all failed that way while the unit tests passed, because those call actions.js
// directly and never enter the wrapper.
for (const match of entry?.matchAll(/async\s+execute\s*\(([^)]*)\)/g) ?? []) {
  const parameters = match[1].split(',').map((name) => name.trim())
  if (!parameters.includes('exec')) {
    fail(`index.js: every execute must declare (args, exec); found (${match[1].trim()})`)
  }
}

// A tool schema is validated by the host, and a keyword outside its accepted subset does not fail one
// tool: it fails the plugin. v0.12.0 shipped `minimum` on a constant that a parameter schema and a
// result schema shared, so the bundle installed and then did not activate -- `JsonSchemaError:
// unsupported JSON schema: ... max_tokens.minimum is not a supported keyword (subset:
// type/oneOf/properties/required/additionalProperties/items/enum/const + annotations)`. Nothing local
// caught it: the unit tests call actions.js and never load the host, and the entry itself parses fine.
// `maxLength` is deliberately absent from this list: the three uses are parameter properties, which the
// host tolerates, and dropping them would lose the range from the model-facing description.
const FORBIDDEN_SCHEMA_KEYWORDS = [
  'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minLength', 'pattern',
  'format', 'minItems', 'maxItems', 'uniqueItems', 'minProperties', 'maxProperties', 'default',
  'examples', 'allOf', 'anyOf', 'not', '$ref', 'definitions', '$defs',
]
const entryLines = entry?.split(/\r?\n/) ?? []
for (const keyword of FORBIDDEN_SCHEMA_KEYWORDS) {
  const pattern = new RegExp(`(^|[{,\\s])${keyword.replace('$', '\\$')}\\s*:`)
  const at = entryLines.findIndex((text) => pattern.test(text))
  if (at !== -1) {
    fail(`index.js:${at + 1}: "${keyword}" is not in the schema subset the host validates; the plugin will not activate`)
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

/**
 * Documents at the top level of `docs/` that are deliberately single-language, each with the reason.
 *
 * This is the only way out of the pair rule below, and it is deliberately a list you have to edit: an
 * unpaired document that is not named here fails the check by name. That is what makes the exception
 * visible in review instead of silent — which is exactly what the hardcoded list of pairs allowed, and why
 * the one unpaired document that existed then, `docs/upstream-lifecycle-gap.md` — a real pair now — could not
 * be told apart from an oversight.
 *
 * A naming convention was the alternative (no language suffix means "single-language by choice"). It was
 * rejected because it records the fact and not the reason: the next reader still could not tell whether
 * somebody meant it, and dropping a suffix would be a way to pass the check without deciding anything.
 */
const SINGLE_LANGUAGE_DOCS = new Map([
  // Empty on purpose: the last entry, `upstream-lifecycle-gap.md`, is a real pair now. The mechanism stays
  // because CONTRIBUTING.md still documents `docs/name.md` as a legal shape, and a declared exception that
  // carries its reason is what makes the next one visible in review.
])

// 5. Bilingual pairs — a rule over docs/, not a list of pairs.
//
// What this replaced was three hardcoded pairs, and a list is not a rule: a new docs/foo-en.md whose
// -zh.md was never written was simply not in the list, so the check said nothing. The one unpaired file that
// existed then, docs/upstream-lifecycle-gap.md, sat there unexamined for exactly that reason, with no way to
// tell a deliberate single-language document from an oversight. Now every file at the top level of docs/ is
// classified below, and one the rule cannot
// classify fails by name.
//
// The four legitimate shapes, and no others:
//
//   docs/name-en.md + docs/name-zh.md   a bilingual pair; both directions are checked, so either half
//                                       missing is a failure that names the file
//   docs/name-en-zh.md                  both languages in ONE file (a two-column glossary). It also ends
//                                       in -zh.md, so the pair rule would read it as "no English side";
//                                       it is therefore matched first, and proven by content — a name is
//                                       not evidence that both languages are in the file
//   docs/name.md                        single-language, and named in SINGLE_LANGUAGE_DOCS with the reason
//   docs/adr/NN-name.md                 out of scope: a decision is English-only and numbered, so it never
//                                       pairs (CONTRIBUTING §6). A directory rule, not one entry per decision.
//
// Root documents are NOT part of this scan and are handled explicitly below: README-zh.md ends in -zh.md
// too, and README.md has no -en suffix, so the README pair is checked by name rather than by suffix.
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/
const LATIN_WORD = /[A-Za-z]{4,}/
const docsDir = join(root, 'docs')
const docNames = readdirSync(docsDir).filter((name) => name.endsWith('.md'))
const docSet = new Set(docNames)
for (const name of docNames) {
  if (name.endsWith('-en-zh.md')) {
    const text = readFileSync(join(docsDir, name), 'utf8')
    if (!CJK.test(text)) fail(`docs/${name}: carries both languages by name but no Chinese text by content`)
    if (!LATIN_WORD.test(text)) fail(`docs/${name}: carries both languages by name but no English prose by content`)
    continue
  }
  if (name.endsWith('-en.md')) {
    const wanted = `${name.slice(0, -'-en.md'.length)}-zh.md`
    if (!docSet.has(wanted)) fail(`docs/${name}: has no docs/${wanted} (bilingual pair)`)
    continue
  }
  if (name.endsWith('-zh.md')) {
    const wanted = `${name.slice(0, -'-zh.md'.length)}-en.md`
    if (!docSet.has(wanted)) fail(`docs/${name}: has no docs/${wanted} (bilingual pair)`)
    continue
  }
  if (!SINGLE_LANGUAGE_DOCS.has(name)) {
    fail(
      `docs/${name}: single-language document with no declaration; add the -en/-zh pair, or list it in `
      + 'SINGLE_LANGUAGE_DOCS in scripts/check.mjs with the one-line reason it is deliberately one language',
    )
  }
}
// The list is a declaration, so it must not outlive the file it describes.
for (const name of SINGLE_LANGUAGE_DOCS.keys()) {
  if (!docSet.has(name)) {
    fail(`docs/${name}: declared single-language in scripts/check.mjs but does not exist; remove the entry`)
  }
}

// Root documents, checked explicitly rather than by the rule above (CONTRIBUTING §6). README.md is the one
// English document without an -en suffix, so the pair is named rather than derived; the rest are
// single-language by the policy there, and this list is also what §6 scans, so naming them once is what
// keeps "which documents exist" and "which documents are single-language" the same question.
for (const name of ['README.md', 'README-zh.md']) {
  if (!existsSync(join(root, name))) fail(`${name}: missing (bilingual pair)`)
}
const ROOT_SINGLE_LANGUAGE = ['AGENTS.md', 'CONTRIBUTING.md', 'PLAN.md', 'PROGRESS.md', 'CHANGELOG.md', 'LICENSE']
for (const name of ROOT_SINGLE_LANGUAGE) {
  if (!existsSync(join(root, name))) fail(`${name}: missing (single-language root document)`)
}

// 6. No machine-specific paths in shared documents.
const documents = [
  'README.md', 'README-zh.md', ...ROOT_SINGLE_LANGUAGE,
  ...docNames.map((name) => `docs/${name}`),
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

// 7. In-repository references resolve.
//
// A citation that cannot be followed is a lie the reader only discovers by looking, and the reader usually
// does not look. This repository has already shipped one: ADR 0025 was cited from about seventeen places
// in roster.js, actions.js and docs/architecture-en.md before that ADR existed, and nothing noticed until a
// survey grepped for it. Two mechanical forms are checked here:
//
//   - a document reference — `docs/<name>.md`, with or without -en/-zh, in prose or a link — must exist;
//   - a section reference — §N, §N.M, §N.M.K — must resolve to a numbered heading in the document it
//     points at.
//
// Which document a section reference points at is decided in this order, and the order is the rule:
//   1. the document the same citation names. "`docs/architecture-en.md` §4.5" and "§4.5 of
//      `docs/architecture-en.md`" both say it, and so does a continuation on the same line — "§4.5 and
//      §4.5.2", "§4.2/§4.3/§4.4". A markdown link counts too, which is the form the README pair uses:
//      "[docs/architecture-en.md](docs/architecture-en.md) §5" names its document as plainly as the
//      backticked form does, and the document-reference pass above already reads a link.
//   2. for a bare §, the document it appears in, when that document has the heading. A document citing its
//      own section is the common case and the strongest reading available; it is not a guess.
//   3. otherwise the one English document at the top level of docs/ that has the heading, when exactly one
//      does. That is what makes a bare "§4.3" in an ADR resolve, and what makes it fail when two documents
//      both have a §4.3: an ambiguous citation is reported, never resolved by picking one.
//   4. otherwise it fails.
//
// Deliberately out of scope, each for a reason:
//   - PROGRESS.md and CHANGELOG.md are append-only history. An entry that cited §4.3 before the section was
//     renamed is correct as of the commit that wrote it; re-checking history would force edits to a record
//     that may not be rewritten, which costs more than the stale citation it would catch.
//   - a section reference into a root document is checked as a document reference only. AGENTS.md numbers
//     its points in prose ("§4.8" is the eighth point of §4) and its headings carry single numbers, so the
//     heading test would call a correct citation wrong.
//   - the six host modules ARE read: their comments cite these documents, they are current-state
//     commentary rather than history, and there are seven section references and two document references
//     between them today. scripts/ is not read — its `docs/` strings are patterns, not citations.
const SECTION = '\\d+(?:\\.\\d+)*'
const headingCache = new Map()
const headingsOf = (relative) => {
  if (headingCache.has(relative)) return headingCache.get(relative)
  const text = existsSync(join(root, relative)) ? readFileSync(join(root, relative), 'utf8') : ''
  const numbers = new Set()
  for (const line of text.split(/\r?\n/)) {
    const match = new RegExp(`^#{1,6}\\s+(${SECTION})[.\\s]`).exec(line)
    if (match !== null) numbers.add(match[1])
  }
  headingCache.set(relative, numbers)
  return numbers
}
// Where the qualified forms live; a bare § may only fall back to the English side, because a translated
// document repeats every number the English one has and would make every fallback ambiguous.
const sectionTargets = docNames.filter((name) => name.endsWith('-en.md')).map((name) => `docs/${name}`)
const referenceSources = [
  ...docNames.map((name) => `docs/${name}`),
  ...readdirSync(join(root, 'docs', 'adr')).filter((name) => name.endsWith('.md')).map((name) => `docs/adr/${name}`),
  'README.md', 'README-zh.md', 'AGENTS.md', 'CONTRIBUTING.md', 'PLAN.md',
  ...hostModules,
]
const DOCUMENT = '`?((?:docs/)?[A-Za-z0-9._/+-]+\\.md)(?::\\d+(?:-\\d+)?)?`?'
const qualifiedThenSection = new RegExp(`${DOCUMENT}\\s*[,;:]?\\s*§\\s*(${SECTION})`, 'g')
const sectionThenQualified = new RegExp(`§\\s*(${SECTION})\\s*(?:of|in)\\s+${DOCUMENT}`, 'g')
// The short form: the document's stem alone — "member-lifecycle §3", "handoff §2", "architecture §2.5".
// It counts only when docs/<stem>-en.md exists, so ordinary prose ("the external review's §3", "see §4")
// stays a bare reference instead of being read as a document nobody named.
const shortThenSection = new RegExp(`(?<![\\w/-])([a-z][a-z0-9-]*)\\s+§\\s*(${SECTION})`, 'g')
// The markdown-link form, which is how the README pair names a document before a section: the target is read
// from the link destination, the authoritative half of the pair. Without it this citation is reported
// ambiguous — two documents have a §5 — and the only repair would be contorting correct prose to suit the
// checker, which is the opposite of what this section is for.
const linkThenSection = new RegExp(`\\[[^\\]]*\\]\\(([^)\\s]+\\.md)\\)\\s*[,;:]?\\s*§\\s*(${SECTION})`, 'g')
const anySection = new RegExp(`§\\s*(${SECTION})`, 'g')
const CONTINUES = /^[\s,;、/]*(?:and|or|与|和|及|或)?[\s,;、/]*$/
const resolveTarget = (token) => {
  const cleaned = token.replace(/:\d+(?:-\d+)?$/, '')
  if (cleaned.startsWith('docs/')) return cleaned
  return existsSync(join(root, 'docs', cleaned)) ? `docs/${cleaned}` : cleaned
}
const checkSection = (file, target, section) => {
  if (!existsSync(join(root, target))) {
    fail(`${file}: cites ${target} §${section}, but ${target} does not exist`)
    return
  }
  if (!target.startsWith('docs/')) return // a root document: its numbering is prose, not headings
  if (!headingsOf(target).has(section)) fail(`${file}: ${target} has no §${section}`)
}
for (const file of referenceSources) {
  const text = existsSync(join(root, file)) ? readFileSync(join(root, file), 'utf8') : ''
  for (const line of text.split(/\r?\n/)) {
    const qualified = []
    for (const match of line.matchAll(qualifiedThenSection)) {
      qualified.push({ start: match.index, end: match.index + match[0].length, section: match[2], target: resolveTarget(match[1]) })
    }
    for (const match of line.matchAll(sectionThenQualified)) {
      qualified.push({ start: match.index, end: match.index + match[0].length, section: match[1], target: resolveTarget(match[2]) })
    }
    for (const match of line.matchAll(shortThenSection)) {
      const stem = match[1]
      if (!existsSync(join(root, 'docs', `${stem}-en.md`))) continue
      qualified.push({ start: match.index, end: match.index + match[0].length, section: match[2], target: `docs/${stem}-en.md` })
    }
    for (const match of line.matchAll(linkThenSection)) {
      qualified.push({ start: match.index, end: match.index + match[0].length, section: match[2], target: resolveTarget(match[1]) })
    }
    for (const mark of qualified) checkSection(file, mark.target, mark.section)
    for (const match of line.matchAll(anySection)) {
      const at = match.index
      if (qualified.some((mark) => at >= mark.start && at < mark.end)) continue
      const section = match[1]
      const previous = qualified.filter((mark) => mark.end <= at).pop()
      if (previous !== undefined && CONTINUES.test(line.slice(previous.end, at))) {
        checkSection(file, previous.target, section)
        continue
      }
      if (headingsOf(file).has(section)) continue
      const owners = sectionTargets.filter((candidate) => headingsOf(candidate).has(section))
      if (owners.length === 1) continue
      if (owners.length === 0) {
        fail(`${file}: §${section} does not resolve — not a heading here, and no document under docs/ has it`)
      } else {
        fail(`${file}: §${section} is ambiguous — ${owners.join(' and ')} all have it; name the document`)
      }
    }
    // A document reference must exist, whether it is backticked prose or a markdown link. A token with a
    // capital in it is a pattern, not a citation — every real document is lowercase (CONTRIBUTING §5) —
    // which is what keeps `docs/adr/NN-name.md` in the naming table from being read as a missing file.
    for (const match of line.matchAll(/`(docs\/[A-Za-z0-9._/+-]+\.md)(?::\d+(?:-\d+)?)?`/g)) {
      if (/[A-Z]/.test(match[1])) continue
      if (!existsSync(join(root, match[1]))) fail(`${file}: cites ${match[1]}, which does not exist`)
    }
    for (const match of line.matchAll(/\]\(([^()\s]+\.md)\)/g)) {
      const target = match[1]
      if (target.includes('/') || target.startsWith('http')) continue
      const base = file.includes('/') ? `${file.slice(0, file.lastIndexOf('/'))}/` : ''
      if (!existsSync(join(root, base + target))) fail(`${file}: links to ${base}${target}, which does not exist`)
    }
  }
}

// 8. Shipped templates: published with the bundle, and describing the role rather than the route.
//    A template that named a provider, a model or a preset would pin every profile that starts that role
//    to whatever was current the day the file was written, so the rule is structural: a shipped template
//    declares `name`, `label` and `assignment`, and any other frontmatter key is refused by name. A
//    workspace definition may declare the route — that is the user's bill to choose (ADR 0018).
const TEMPLATE_DIR = 'templates/definitions'
const TEMPLATE_FIELDS = ['assignment', 'label', 'name']
const templateFiles = existsSync(join(root, TEMPLATE_DIR))
  ? readdirSync(join(root, TEMPLATE_DIR)).filter((name) => name.endsWith('.md')).sort()
  : []
if (templateFiles.length === 0) fail(`${TEMPLATE_DIR}: ships no template`)
for (const name of templateFiles) {
  const relative = `${TEMPLATE_DIR}/${name}`
  // Published, or an installed bundle loses the file it ships. npm reads a bare directory entry as
  // "everything under it", so `templates/` is what publishes this file; nothing smaller does.
  const published = (manifest?.files ?? []).some((entry) => {
    const cleaned = entry.replace(/^\.\//, '').replace(/\/+$/, '')
    return relative === cleaned || relative.startsWith(`${cleaned}/`)
  })
  if (!published) fail(`package.json: files must publish "${relative}"`)
  const lines = (read(relative) ?? '').split(/\r?\n/)
  if (lines[0] !== '---') {
    fail(`${relative}: must open with "---" on line 1, as the definition parser requires`)
    continue
  }
  const close = lines.indexOf('---', 1)
  for (const line of lines.slice(1, close === -1 ? lines.length : close)) {
    const match = /^([A-Za-z][A-Za-z0-9_]*): /.exec(line)
    if (match === null || TEMPLATE_FIELDS.includes(match[1])) continue
    fail(`${relative}: declares "${match[1]}"; a shipped template describes the role — its frontmatter is ${TEMPLATE_FIELDS.join(', ')} and nothing else, because the route belongs to whoever starts the member`)
  }
}

if (failures.length > 0) {
  console.error(`check failed: ${failures.length} problem(s)`)
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
console.log('check passed')
