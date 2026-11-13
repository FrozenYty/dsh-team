/**
 * Ask the Host's own schema validator whether this bundle's tool schemas are acceptable.
 *
 * **This is a local check, not a CI gate.** It reads the installed Harness archive, and CI has no
 * Harness: `scripts/check.mjs` stays the gate that runs everywhere. What this adds is the one question a
 * repository cannot answer from its own files — whether the validator inside the asar accepts what we
 * declare — and it is the validator that decides whether a tool exists at all: the registry asserts every
 * output schema before the tool is registered.
 *
 * What it does, in order:
 *
 *   1. takes the validator out of the archive — the module and everything it imports, read through the
 *      archive's own header, with no python and no bundler;
 *   2. runs it over every tool's output schema (the assertion `register()` performs) and over every
 *      parameter schema (which the Host projects without asserting — reported, not failed on);
 *   3. runs it over real results the tools produced through their wrappers, so an output schema is
 *      checked against values rather than against nothing;
 *   4. prints a per-tool line and a summary, and exits non-zero when the Host rejects anything.
 *
 * A rejection is the finding. Nothing here loosens a schema to make a run pass; a finding is reported and
 * left for the owner to decide.
 *
 * Usage: `node scripts/schema-check.mjs` (set `DSH_ASAR` to check another build).
 */

import { mkdir, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { apply } from '../index.js'

/** Where this machine's Harness keeps its build. Overridable, because the build moves. */
export const DEFAULT_ASAR = 'D:\\DeepSeek Harness\\resources\\app.asar'

/** The package entry the Host itself re-exports the validator from, so the code is the same instance. */
export const VALIDATOR_ENTRY = 'dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js'

const BUILTINS = new Set(['assert', 'buffer', 'child_process', 'crypto', 'events', 'fs', 'http', 'https', 'module', 'os', 'path', 'process', 'stream', 'url', 'util', 'zlib'])

/**
 * Read an asar's header and file table, without loading the archive.
 *
 * The first 16 bytes are three size fields — the pickled header total, that total less its own size field,
 * and the JSON's own byte length — so the JSON starts at 16 and the file data starts where it ends. The
 * archive here is 213 MB, so only the bytes that are asked for are ever read.
 * @param {string} path - the archive.
 * @returns {Promise<{path: string, handle: object, files: Map<string, {offset: number, size: number}>}>}
 */
export async function openArchive(path) {
  const handle = await open(path, 'r')
  const head = Buffer.alloc(16)
  await handle.read(head, 0, 16, 0)
  const jsonSize = head.readUInt32LE(12)
  const json = Buffer.alloc(jsonSize)
  await handle.read(json, 0, jsonSize, 16)
  // The same derivation the archive tooling uses (`8 + u32(4)`), which equals the end of the JSON.
  const base = 8 + head.readUInt32LE(4)
  const files = new Map()
  const walk = (node, prefix) => {
    for (const [name, entry] of Object.entries(node.files ?? {})) {
      const entryPath = `${prefix}${name}`
      if (entry.files !== undefined) walk(entry, `${entryPath}/`)
      else if (entry.offset !== undefined) files.set(entryPath, { offset: base + Number(entry.offset), size: Number(entry.size) })
    }
  }
  walk(JSON.parse(json.toString('utf8')), '')
  return { path, handle, files }
}

/** Read one archived file's bytes. */
export async function readArchived(archive, path) {
  const entry = archive.files.get(path)
  if (entry === undefined) throw new Error(`${path} is not in ${archive.path}`)
  const buffer = Buffer.alloc(entry.size)
  await archive.handle.read(buffer, 0, entry.size, entry.offset)
  return buffer
}

/** The module specifiers one file imports, in the order they appear, ignoring comments. */
export function specifiersOf(text) {
  const source = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const found = []
  for (const match of source.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)['"]([^'"]+)['"]/g)) found.push(match[1])
  return found
}

/** The archive paths Node would try for one specifier, in order. Archive paths are `/`-separated. */
export function resolutionCandidates(fromPath, specifier) {
  if (specifier.startsWith('./') || specifier.startsWith('../')) {
    const parts = fromPath.split('/').slice(0, -1)
    for (const step of specifier.split('/')) {
      if (step === '.' || step === '') continue
      else if (step === '..') parts.pop()
      else parts.push(step)
    }
    return [parts.join('/')]
  }
  const candidates = []
  const parts = fromPath.split('/').slice(0, -1)
  for (;;) {
    candidates.push([...parts, 'node_modules', specifier].join('/'))
    const at = parts.lastIndexOf('node_modules')
    if (at === -1) break
    parts.length = at
  }
  return candidates
}

/** The `default`-ish target of an `exports` value, which may be a string, an array or a condition map. */
function pickCondition(value) {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    for (const each of value) {
      const picked = pickCondition(each)
      if (picked !== undefined) return picked
    }
    return undefined
  }
  if (value === null || typeof value !== 'object') return undefined
  for (const key of ['node', 'import', 'module', 'default', 'require']) {
    if (value[key] !== undefined) {
      const picked = pickCondition(value[key])
      if (picked !== undefined) return picked
    }
  }
  return undefined
}

/** Resolve one file path inside the archive: the file itself, a package entry, or an index. */
async function resolveTarget(archive, candidate) {
  if (archive.files.has(candidate)) return candidate
  if (archive.files.has(`${candidate}/package.json`)) {
    const pkg = JSON.parse((await readArchived(archive, `${candidate}/package.json`)).toString('utf8'))
    const entry = pickCondition(pkg.exports?.['.'] ?? pkg.exports) ?? pkg.module ?? pkg.main ?? 'index.js'
    return await resolveTarget(archive, `${candidate}/${String(entry).replace(/^\.\//, '')}`)
  }
  for (const suffix of ['.js', '.mjs', '.cjs', '/index.js']) {
    if (archive.files.has(candidate + suffix)) return candidate + suffix
  }
  return undefined
}

/** Resolve one specifier the way Node would, including a package's own `exports` subpaths. */
export async function resolveModule(archive, fromPath, specifier) {
  if (specifier.startsWith('.')) return await resolveTarget(archive, resolutionCandidates(fromPath, specifier)[0])
  const segments = specifier.split('/')
  const packageName = specifier.startsWith('@') ? segments.slice(0, 2).join('/') : segments[0]
  const subpath = specifier.slice(packageName.length)
  for (const candidate of resolutionCandidates(fromPath, packageName)) {
    if (!archive.files.has(`${candidate}/package.json`)) continue
    const pkg = JSON.parse((await readArchived(archive, `${candidate}/package.json`)).toString('utf8'))
    if (subpath !== '') {
      const target = pickCondition(pkg.exports?.[`.${subpath}`])
      if (target !== undefined) return await resolveTarget(archive, `${candidate}/${String(target).replace(/^\.\//, '')}`)
    }
    return await resolveTarget(archive, candidate)
  }
  return undefined
}

/**
 * Extract a module and everything it imports into a directory, preserving archive paths so Node resolves
 * the same relative imports and the same package boundaries the archive declared.
 * @param {object} archive - `openArchive` result.
 * @param {string} entryPath - the archive path to start from.
 * @param {string} outDir - where to write.
 * @returns {Promise<{entry: string, files: string[], missing: object[]}>}
 */
export async function extractClosure(archive, entryPath, outDir) {
  const files = []
  const missing = []
  const packages = new Set()
  const queue = [entryPath]
  const seen = new Set()
  while (queue.length > 0) {
    const path = queue.pop()
    if (seen.has(path)) continue
    seen.add(path)
    const buffer = await readArchived(archive, path)
    const target = join(outDir, ...path.split('/'))
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, buffer)
    files.push(path)
    const segments = path.split('/')
    const at = segments.lastIndexOf('node_modules')
    // A scoped package is two segments (`@scope/name`), an unscoped one is one.
    const scope = at !== -1 && segments[at + 1].startsWith('@')
    if (at !== -1) packages.add(segments.slice(0, at + (scope ? 3 : 2)).join('/'))
    if (!path.endsWith('.js') && !path.endsWith('.mjs') && !path.endsWith('.cjs')) continue
    for (const specifier of specifiersOf(buffer.toString('utf8'))) {
      if (specifier.startsWith('node:') || BUILTINS.has(specifier)) continue
      const resolved = await resolveModule(archive, path, specifier)
      if (resolved === undefined) missing.push({ from: path, specifier })
      else queue.push(resolved)
    }
  }
  // The module type of each package has to travel with its files, or Node reads ESM as CommonJS.
  for (const root of packages) {
    if (archive.files.has(`${root}/package.json`)) {
      const target = join(outDir, ...`${root}/package.json`.split('/'))
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, await readArchived(archive, `${root}/package.json`))
      files.push(`${root}/package.json`)
    }
  }
  return { entry: join(outDir, ...entryPath.split('/')), files, missing }
}

/**
 * The Host's validator, out of the archive.
 *
 * `assertSupportedJsonSchema` is the assertion `tools.register()` runs on an output schema before a tool
 * exists; `validateJsonSchemaValue` is what a dispatch validates a value with. Both are taken from the
 * package entry the Host itself imports, so they are the same code, not a copy of it.
 * @param {string} asarPath - the archive.
 * @returns {Promise<{validator: object, identity: object, keys: string[]}>}
 */
export async function loadValidator(asarPath) {
  const archive = await openArchive(asarPath)
  const dir = await mkdtemp(join(tmpdir(), 'dsh-schema-check-'))
  const { entry, files, missing } = await extractClosure(archive, VALIDATOR_ENTRY, dir)
  const pkg = JSON.parse((await readArchived(archive, 'dsh/node_modules/@deepseek-ai/dsh-tools/package.json')).toString('utf8'))
  const module = await import(pathToFileURL(entry).href)
  await archive.handle.close()
  return {
    module,
    extractDir: dir,
    validator: {
      assertOutput: (schema) => module.assertSupportedJsonSchema(schema),
      assertObjectRoot: (schema) => module.assertObjectJsonSchema(schema),
      validate: (schema, value) => module.validateJsonSchemaValue(schema, value, 'result'),
    },
    identity: {
      package: `${pkg.name} ${pkg.version}`,
      module: 'dsh-tools/lib/index.js',
      functions: ['assertSupportedJsonSchema', 'assertObjectJsonSchema', 'validateJsonSchemaValue'],
      error: 'JsonSchemaError (code UNSUPPORTED_SCHEMA)',
      extractedFiles: files.length,
      missing,
    },
  }
}

/** One assertion, as a row the report can print. */
function attempt(run) {
  try {
    run()
    return { ok: true, violations: [] }
  } catch (error) {
    return { ok: false, violations: error?.violations ?? [error instanceof Error ? error.message : String(error)] }
  }
}

/**
 * Run the validator over the declared schemas and the real results.
 *
 * Pure apart from the validator it is handed, which is what lets the test drive it without an archive.
 * @param {{validator: object, tools: Array<object>, results: Array<object>}} request - the validator, one
 *   `{name, parameters, output}` per registered tool, and one `{tool, args, value?, error?}` per call made.
 * @returns {{tools: Array<object>, failures: object[], notes: object[]}}
 */
export function checkSchemas({ validator, tools, results }) {
  const failures = []
  const notes = []
  const byTool = new Map(tools.map((tool) => [tool.name, { name: tool.name, results: [] }]))
  for (const tool of tools) {
    const row = byTool.get(tool.name)
    // The assertion the registry performs, on the schema it performs it on.
    row.output = attempt(() => validator.assertOutput(tool.output.schema))
    if (!row.output.ok) failures.push({ tool: tool.name, where: 'output schema', violations: row.output.violations })
    // Our outputs are object-rooted and the Host's structured-output path requires it; a violation here
    // is reported, and is fatal only if the subset assertion also failed (the two are cumulative).
    row.objectRoot = attempt(() => validator.assertObjectRoot(tool.output.schema))
    if (!row.objectRoot.ok && row.output.ok) {
      notes.push({ tool: tool.name, where: 'output schema is not object-rooted', violations: row.objectRoot.violations })
    }
    // Parameters are projected straight to the model and never asserted by the registry, so a violation
    // is information — the keyword would simply not be enforced — and not a reason to fail.
    row.parameters = { ...attempt(() => validator.assertOutput(tool.parameters)), informational: true }
    if (!row.parameters.ok) {
      notes.push({ tool: tool.name, where: 'parameter schema is outside the subset (the Host projects it unasserted)', violations: row.parameters.violations })
    }
  }
  for (const result of results) {
    const row = byTool.get(result.tool)
    if (row === undefined) continue
    if (result.error !== undefined) {
      row.results.push({ args: result.args, error: result.error })
      notes.push({ tool: result.tool, where: 'the call threw, so no value was checked', violations: [result.error] })
      continue
    }
    const tool = tools.find((each) => each.name === result.tool)
    const checked = attempt(() => validator.validate(tool.output.schema, result.value))
    row.results.push({ args: result.args, ...checked })
    if (!checked.ok) failures.push({ tool: result.tool, where: 'real result', violations: checked.violations })
  }
  return { tools: [...byTool.values()], failures, notes }
}

/**
 * Drive this bundle's tool wrappers with a minimal Host context, so the results checked are values the
 * tools actually produced. The same shape the entry tests use; the calls are chosen to return, not throw.
 *
 * **Exported, and that is the point.** This is the half of the check that needs no archive: it is the fake
 * Host, and the drift that once rotted this script was a fake that no longer matched what the bundle reads
 * (every Session got a data root, and the harness here gave its Lead no workspace). A unit test drives it
 * on every push, with a validator that records what it was asked and the Host's own validator when an
 * archive is present. `services` is what this harness answers, so the test can hold it against the
 * bundle's own `inject` list: a service the bundle starts requiring and this fake does not provide fails
 * the test by name, which is the failure a reader of a green report would never see.
 * @returns {Promise<{tools: Array<object>, results: Array<object>, services: string[]}>}
 */
export async function collectFromBundle() {
  const { ROSTER_FILE_NAME } = await import('../roster.js')
  const { TEAM_DIR } = await import('../trash.js')
  const tools = new Map()
  const childTools = new Map()
  // Every Session is bound to a data root (ADR 0031), so the harness gives its Lead a workspace: a Session
  // with no working directory would write its roster under the operator's real home directory, and the store
  // would not be the thing this script drives. Nothing here needs a storage domain — the bundle opens none.
  const workspace = await mkdtemp(join(tmpdir(), 'dsh-team-schema-'))
  const lead = {
    id: 'lead-1',
    status: 'idle',
    session: { id: 'lead-1', header: { cwd: workspace } },
    ctx: { tools: { register: (definition) => { tools.set(definition.name, definition); return () => tools.delete(definition.name) } } },
  }
  const child = {
    id: 'child-1',
    status: 'idle',
    session: { id: 'child-1', header: { parentSession: 'lead-1' } },
    ctx: { tools: { register: (definition) => { childTools.set(definition.name, definition); return () => childTools.delete(definition.name) } } },
  }
  // The services this fake Host answers, and nothing else is answered below. `compaction` is not one of
  // them: the bundle asks for it lazily and tolerates its absence, so it is a lookup, not an injection.
  const services = {
    agents: { list: () => [lead, child], get: (id) => (id === lead.id ? lead : id === child.id ? child : undefined) },
    agentTeams: { tryMembership: () => undefined, listMembers: () => [] },
    subagents: {
      listDescendants: async () => [],
      startActivation: async (spec) => ({ childId: spec.childId }),
      drainChildren: async () => {},
      sendMessage: async () => 'message-1',
      interrupt: () => {},
      getProvider: (name) => (name === 'spawn' ? { name, capabilities: { agentOptions: true, agentPreset: true } } : undefined),
    },
    // The registry the bundle's tools register into, through the agent context. Declared because the bundle
    // injects it, and an injection the host cannot answer is what stops the plugin loading at all.
    tools: {},
    tokenMeter: { contextPressure: () => ({ pressureTokens: 0, contextWindow: 0 }) },
  }
  const ctx = {
    ...services,
    get: (name) => {
      if (name === 'compaction') return {}
      return services[name]
    },
    inject: (names, callback) => { callback(); return { then: () => {} } },
    on: () => () => {},
    effect: (install) => { install(); return () => {} },
    logger: { warn() {} },
  }
  apply(ctx, undefined)

  const steps = [
    ['spawn_member', { name: 'reviewer', label: 'Reviewer', prompt: 'Review the parser.' }],
    ['task_board', { action: 'create', title: 'Recheck the curve', owner: 'reviewer' }],
    ['list_members', {}],
    ['message_member', { target: 'reviewer', message: 'Carry on with the review.' }],
    ['wait_members', {}],
    ['handoff_template', {}],
    ['spawn_member', { name: 'runner', label: 'Runner', prompt: 'Run it.', lifetime: 'one-shot' }],
    ['retire_member', { target: 'runner' }],
    ['restore_member', { target: 'runner' }],
    ['stop_member', { target: 'reviewer' }],
    ['compact_member', { target: 'reviewer' }],
    ['spawn_member', { definition: 'reviewer' }],
  ]
  const results = []
  for (const [tool, args] of steps) {
    const definition = tools.get(tool)
    try {
      results.push({ tool, args, value: await definition.execute(args, { agent: lead }) })
    } catch (error) {
      results.push({ tool, args, error: error instanceof Error ? error.message : String(error) })
    }
  }
  // The member-scoped read is its own declared shape: point the spawned row at the member Agent first. The
  // records live in the roster file the tools just wrote, so the patch is a second writer touching that
  // file — and the store merges a change it did not write at its next write, which is why a write follows
  // it here before the member read.
  const rosterFile = join(workspace, TEAM_DIR, ROSTER_FILE_NAME)
  const stored = JSON.parse(await readFile(rosterFile, 'utf8'))
  const own = stored.rosters['lead-1']
  await writeFile(rosterFile, `${JSON.stringify({
    ...stored,
    serial: stored.serial + 1,
    rosters: {
      ...stored.rosters,
      'lead-1': {
        ...own,
        members: own.members.map((member) => (member.name === 'reviewer' ? { ...member, childId: 'child-1' } : member)),
      },
    },
  }, null, 2)}\n`, 'utf8')
  const board = tools.get('task_board')
  const merge = { action: 'create', title: 'Merge the second writer' }
  try {
    results.push({ tool: 'task_board', args: merge, value: await board.execute(merge, { agent: lead }) })
  } catch (error) {
    results.push({ tool: 'task_board', args: merge, error: error instanceof Error ? error.message : String(error) })
  }
  const memberTool = childTools.get('list_my_tasks')
  try {
    results.push({ tool: 'list_my_tasks', args: {}, value: await memberTool.execute({}, { agent: child }) })
  } catch (error) {
    results.push({ tool: 'list_my_tasks', args: {}, error: error instanceof Error ? error.message : String(error) })
  }
  const declared = [...tools.values()].map((definition) => ({ name: definition.name, parameters: definition.parameters, output: definition.output }))
  const memberDeclared = memberTool === undefined ? [] : [{ name: memberTool.name, parameters: memberTool.parameters, output: memberTool.output }]
  return { tools: [...declared, ...memberDeclared], results, services: Object.keys(services) }
}

/** Render the run the way the operator reads it. */
export function formatReport({ identity, report }) {
  const lines = []
  lines.push('dsh-team schema check — the Host\'s own validator, out of the installed archive')
  lines.push(`validator   ${identity.package} · ${identity.module}`)
  lines.push(`            ${identity.functions.join(', ')} · ${identity.error}`)
  lines.push(`extracted   ${identity.extractedFiles} files (the module and everything it imports)`)
  if (identity.missing.length > 0) lines.push(`WARNING     ${identity.missing.length} specifier(s) did not resolve: ${identity.missing.map((each) => each.specifier).join(', ')}`)
  lines.push('')
  for (const tool of report.tools) {
    const results = tool.results.map((result) => (result.error !== undefined ? 'threw' : result.ok ? 'ok' : 'REJECTED'))
    lines.push([
      tool.name.padEnd(16),
      `output ${tool.output.ok ? 'accepted' : 'REJECTED'}`,
      `parameters ${tool.parameters.ok ? 'accepted' : 'outside the subset (projected, not asserted)'}`,
      `results ${results.length === 0 ? 'none' : results.join(',')}`,
    ].join('  '))
  }
  lines.push('')
  for (const failure of report.failures) {
    lines.push(`REJECTED ${failure.tool} — ${failure.where}`)
    for (const violation of failure.violations) lines.push(`  ${violation}`)
  }
  lines.push('')
  lines.push('summary')
  lines.push(`  tools                        ${report.tools.length}`)
  lines.push(`  output schemas accepted      ${report.tools.filter((tool) => tool.output.ok).length}/${report.tools.length}`)
  lines.push(`  parameter schemas accepted   ${report.tools.filter((tool) => tool.parameters.ok).length}/${report.tools.length} (informational)`)
  lines.push(`  real results checked         ${report.tools.reduce((total, tool) => total + tool.results.filter((result) => result.error === undefined).length, 0)}`)
  lines.push(`  host rejections              ${report.failures.length}`)
  for (const note of report.notes) {
    lines.push(`  note: ${note.tool} — ${note.where}`)
    for (const violation of note.violations) lines.push(`    ${violation}`)
  }
  lines.push('')
  lines.push(report.failures.length === 0
    ? 'verdict: the Host accepts every schema this bundle declares, and every value checked.'
    : `verdict: the Host REJECTED ${report.failures.length} thing(s); see above. Nothing was changed to make this pass.`)
  return lines.join('\n')
}

/** The command line entry point. Exit 0 accepted, 1 rejected, 2 the archive could not be read. */
async function main() {
  const asarPath = process.env.DSH_ASAR ?? DEFAULT_ASAR
  let loaded
  try {
    loaded = await loadValidator(asarPath)
  } catch (error) {
    console.error(`schema-check: could not load the validator from ${asarPath}`)
    console.error(`  ${error instanceof Error ? error.message : String(error)}`)
    return 2
  }
  const { tools, results } = await collectFromBundle()
  const report = checkSchemas({ validator: loaded.validator, tools, results })
  console.log(formatReport({ identity: loaded.identity, report }))
  await rm(loaded.extractDir, { recursive: true, force: true })
  return report.failures.length === 0 ? 0 : 1
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main()
}
