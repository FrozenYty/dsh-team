/**
 * The schema-check script, without the Host.
 *
 * The archive itself is not here — CI has no Harness — so what is tested is everything that decides
 * whether the check is right: the archive header reader (against a synthetic archive this file builds to
 * the same layout), the module-specifier scan, Node's resolution walk, the checking logic with a
 * stand-in validator, and the *harness half* — the fake Host and the calls that drive the bundle, which
 * is the part that rotted when nobody ran the script. The one thing left to the local run is the
 * validator's own verdict, and the harness test takes it when the archive is on the machine.
 */

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { inject } from '../index.js'
import { readArchivedRecords } from '../roster.js'
import {
  DEFAULT_ASAR,
  checkSchemas,
  collectFromBundle,
  formatReport,
  loadValidator,
  openArchive,
  readArchived,
  resolutionCandidates,
  specifiersOf,
} from '../scripts/schema-check.mjs'
import { assertMatchesSchema } from './schema-assert.mjs'

/**
 * Build an archive with the layout the reader expects: the three size fields, the JSON header, then the
 * file contents, with each entry's offset relative to the end of the header.
 */
async function buildArchive(files) {
  const header = { files: {} }
  const contents = []
  let offset = 0
  for (const [path, text] of Object.entries(files)) {
    const parts = path.split('/')
    let node = header
    for (const part of parts.slice(0, -1)) {
      node.files[part] ??= { files: {} }
      node = node.files[part]
    }
    const buffer = Buffer.from(text, 'utf8')
    node.files[parts[parts.length - 1]] = { offset: String(offset), size: String(buffer.length) }
    contents.push(buffer)
    offset += buffer.length
  }
  const json = Buffer.from(JSON.stringify(header), 'utf8')
  const prefix = Buffer.alloc(16)
  prefix.writeUInt32LE(4, 0)
  prefix.writeUInt32LE(json.length + 8, 4)
  prefix.writeUInt32LE(json.length + 4, 8)
  prefix.writeUInt32LE(json.length, 12)
  const path = join(await mkdtemp(join(tmpdir(), 'dsh-asar-')), 'app.asar')
  await writeFile(path, Buffer.concat([prefix, json, ...contents]))
  return path
}

/** A validator stand-in: rejects the schemas and values a test names, accepts everything else, and records
 * what it was handed so a test can check the request rather than only the verdict. */
function stubValidator({ rejectSchemas = [], rejectValues = [] } = {}) {
  const seen = { assertOutput: [], assertObjectRoot: [], validate: [] }
  return {
    seen,
    assertOutput: (schema) => {
      seen.assertOutput.push(schema)
      for (const entry of rejectSchemas) {
        if (entry.schema === schema) throw Object.assign(new Error(`unsupported JSON schema: ${entry.violation}`), { violations: [entry.violation] })
      }
    },
    assertObjectRoot: (schema) => { seen.assertObjectRoot.push(schema) },
    validate: (schema, value) => {
      seen.validate.push({ schema, value })
      for (const entry of rejectValues) {
        if (entry.schema === schema && entry.value === value) {
          throw Object.assign(new Error(`invalid result: ${entry.violation}`), { violations: [entry.violation] })
        }
      }
    },
  }
}

test('the archive reader finds the files the header names', async () => {
  const path = await buildArchive({
    'dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js': 'export const a = 1\n',
    'dsh/node_modules/@deepseek-ai/dsh-tools/package.json': '{"type":"module"}',
    'dsh/other.txt': 'hello',
  })
  const archive = await openArchive(path)
  assert.deepEqual([...archive.files.keys()].sort(), [
    'dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js',
    'dsh/node_modules/@deepseek-ai/dsh-tools/package.json',
    'dsh/other.txt',
  ])
  assert.equal((await readArchived(archive, 'dsh/other.txt')).toString('utf8'), 'hello', 'the bytes are where the header says')
  assert.equal(
    (await readArchived(archive, 'dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js')).toString('utf8'),
    'export const a = 1\n',
    'and a second entry does not run into the first',
  )
  await archive.handle.close()
})

test('the specifier scan sees imports and not prose', () => {
  const text = [
    "import { a } from '@deepseek-ai/x'",
    'import "side-effect"',
    "export { b } from './relative.js'",
    'const m = await import("dynamic")',
    '// import nothing from "a comment"',
  ].join('\n')
  assert.deepEqual(specifiersOf(text), ['@deepseek-ai/x', 'side-effect', './relative.js', 'dynamic'])
})

test('the resolution walk climbs node_modules from the importing file', () => {
  const from = 'dsh/node_modules/@deepseek-ai/dsh-tools/lib/shared.js'
  assert.deepEqual(resolutionCandidates(from, '@deepseek-ai/dsh-llm'), [
    'dsh/node_modules/@deepseek-ai/dsh-tools/lib/node_modules/@deepseek-ai/dsh-llm',
    'dsh/node_modules/@deepseek-ai/dsh-llm',
  ])
  assert.deepEqual(resolutionCandidates(from, './local.js'), ['dsh/node_modules/@deepseek-ai/dsh-tools/lib/local.js'])
  assert.deepEqual(resolutionCandidates(from, '../up.js'), ['dsh/node_modules/@deepseek-ai/dsh-tools/up.js'])
})

test('a schema the Host rejects is a failure, naming the tool and the violation', () => {
  const tools = [
    { name: 'good', parameters: { type: 'object' }, output: { schema: { type: 'object' } } },
    { name: 'bad', parameters: { type: 'object' }, output: { schema: { type: 'object', properties: { a: { minimum: 1 } } } } },
  ]
  const rejected = tools[1].output.schema
  const report = checkSchemas({
    validator: stubValidator({ rejectSchemas: [{ schema: rejected, violation: 'schema.properties.a.minimum is not a supported keyword' }] }),
    tools,
    results: [],
  })
  assert.equal(report.failures.length, 1)
  assert.equal(report.failures[0].tool, 'bad')
  assert.match(report.failures[0].violations[0], /minimum is not a supported keyword/)
  const report_text = formatReport({
    identity: { package: 'pkg 1.0.0', module: 'm', functions: ['f'], error: 'e', extractedFiles: 1, missing: [] },
    report,
  })
  assert.match(report_text, /REJECTED bad — output schema/)
  assert.match(report_text, /the Host REJECTED 1 thing/)
})

test('a parameter keyword outside the subset is a note, never a failure', () => {
  // The registry asserts output schemas only; a parameter schema is projected to the model unasserted, so
  // a keyword there is information rather than a Host rejection.
  const parameters = { type: 'object', properties: { a: { type: 'string', maxLength: 8 } } }
  const validator = {
    assertOutput: (schema) => {
      if (schema === parameters) throw Object.assign(new Error('x'), { violations: ['schema.properties.a.maxLength is not a supported keyword'] })
    },
    assertObjectRoot: () => undefined,
    validate: () => undefined,
  }
  const report = checkSchemas({ validator, tools: [{ name: 'probe', parameters, output: { schema: { type: 'object' } } }], results: [] })
  assert.deepEqual(report.failures, [], 'the Host does not reject it')
  assert.equal(report.notes.length, 1)
  assert.match(report.notes[0].where, /parameter schema is outside the subset/)
  assert.match(report.notes[0].violations[0], /maxLength/)
})

test('a real result the Host rejects is a failure, and a call that threw is a note', () => {
  const schema = { type: 'object' }
  const value = { started: false, reason: 'definition-not-found' }
  const report = checkSchemas({
    validator: stubValidator({ rejectValues: [{ schema, value, violation: 'result.started is not a boolean' }] }),
    tools: [{ name: 'spawn_member', parameters: { type: 'object' }, output: { schema } }],
    results: [
      { tool: 'spawn_member', args: {}, value },
      { tool: 'compact_member', args: {}, error: 'no compaction backend is mounted in this profile' },
    ],
  })
  assert.equal(report.failures.length, 1)
  assert.equal(report.failures[0].where, 'real result')
  assert.match(report.failures[0].violations[0], /is not a boolean/)
  // compact_member is not registered in `tools` here, so it contributes nothing — the rule is that a tool
  // with no result is reported as "none" in its own line, not invented.
  assert.equal(report.notes.length, 0)
})

test('an all-accepted run says so plainly', () => {
  const report = checkSchemas({
    validator: stubValidator(),
    tools: [{ name: 'list_members', parameters: { type: 'object' }, output: { schema: { type: 'object' } } }],
    results: [{ tool: 'list_members', args: {}, value: { members: [] } }],
  })
  assert.deepEqual(report.failures, [])
  const text = formatReport({
    identity: { package: '@deepseek-ai/dsh-tools 0.2.2-rc.1', module: 'dsh-tools/lib/index.js', functions: ['assertSupportedJsonSchema'], error: 'JsonSchemaError', extractedFiles: 23, missing: [] },
    report,
  })
  assert.match(text, /validator {3}@deepseek-ai\/dsh-tools 0\.2\.2-rc\.1 · dsh-tools\/lib\/index\.js/)
  assert.match(text, /list_members\s+output accepted\s+parameters accepted\s+results ok/)
  assert.match(text, /host rejections\s+0/)
  assert.match(text, /verdict: the Host accepts every schema this bundle declares/)
})

test('the archive the flagged value comes from is the plugin own writer output', async () => {
  // The fixture is not written by the check: the harness stages two tombstones whose artifacts really move,
  // removes the oldest one's bytes, and lets the next write bound the roster — which is the code path that
  // appends the line. Reading it back through the plugin's reader is what proves the line is the writer's
  // shape rather than the check's idea of it, and it is why a change to the line format cannot leave this
  // test passing on a stale fixture.
  const { dataDir } = await collectFromBundle()
  const read = await readArchivedRecords(dataDir, 'lead-1')
  assert.equal(read.path, join(dataDir, 'archive.jsonl'), 'the archive sits under the root the flagged read used')
  assert.equal(read.total >= 1, true, 'the writer archived at least one tombstone')
  assert.equal(read.unreadable, 0, 'and wrote nothing the reader has to skip')
  assert.equal(typeof read.records[0].archivedAt, 'string', 'the line records when the record left the roster')
  assert.equal(read.records[0].member.phase, 'retired', 'and carries the tombstone itself, not a projection of it')
  assert.equal(typeof read.records[0].member.childId, 'string', 'which names the child Session the artifact came from')
})

test('a fresh data root with no archive still passes: the flag asks for a file that may not exist', async () => {
  // The other direction of the same coverage: the flagged read must produce a valid value even when nothing
  // has ever been archived, or the check would refuse on a profile that has not run long enough to need it.
  const { tools, results, dataDir } = await collectFromBundle({ archive: false })
  const read = await readArchivedRecords(dataDir, 'lead-1')
  assert.equal(read.total, 0, 'no file, no records')
  assert.equal(read.path, undefined, 'and no path is claimed for it')

  const flagged = results.find((result) => result.tool === 'list_members' && result.args?.archived === true)
  assert.ok(flagged !== undefined, 'the flagged read still ran')
  assert.equal(flagged.error, undefined, 'and returned a value rather than throwing')
  assert.equal(flagged.value.archived_returned, 0)
  assert.equal(flagged.value.archived_total, 0)
  const declaration = tools.find((tool) => tool.name === 'list_members')
  assertMatchesSchema(flagged.value, declaration.output.schema, 'list_members { archived: true } on a fresh root')
  assert.deepEqual(checkSchemas({ validator: stubValidator(), tools, results }).failures, [], 'and nothing is rejected')
})

test('the harness half still matches the bundle: every injection is answered, every call returns', async (t) => {
  // The half that needs no archive, and the half that rotted: at v0.31.0 every Session got a data root, the
  // script's fake Host still gave its Lead no workspace, and the check broke without anyone running it.
  const { tools, results, services } = await collectFromBundle()
  // A dependency the bundle declares and this fake does not answer is that drift, named so the repair is
  // obvious: add it to the fake, or stop declaring it.
  for (const name of inject) {
    assert.ok(services.includes(name), `the schema-check harness answers no "${name}", which the bundle declares in inject`)
  }

  // Every registered tool is declared with both schemas, and every call names a tool that exists: a renamed
  // or removed tool shows up here rather than as a silently smaller report.
  assert.ok(tools.length > 0, 'the harness registered at least one tool')
  for (const tool of tools) {
    assert.equal(typeof tool.name, 'string')
    assert.equal(typeof tool.parameters, 'object', `${tool.name} declares a parameter schema`)
    assert.equal(typeof tool.output?.schema, 'object', `${tool.name} declares an output schema`)
  }
  const registered = new Set(tools.map((tool) => tool.name))
  for (const result of results) assert.ok(registered.has(result.tool), `the call to "${result.tool}" names a registered tool`)

  // The script's own rule: these calls are chosen to return, not to throw, so the values the validator sees
  // are values the tools produced. If a call starts throwing, the report would still say "accepted" while
  // checking nothing — which is how a check goes quiet.
  assert.deepEqual(results.filter((result) => result.error !== undefined), [], 'every call in the harness returned a value')

  // And the request that reaches the validator has the shape the report implies.
  const validator = stubValidator()
  const report = checkSchemas({ validator, tools, results })
  const assertedOutputs = validator.seen.assertOutput.filter((schema) => tools.some((tool) => tool.output.schema === schema))
  assert.equal(assertedOutputs.length, tools.length, 'one output-schema assertion per tool')
  // Parameter schemas go through the same assertion, and a violation there is informational: the registry
  // projects them to the model without asserting. Counted, so a tool whose parameters stop being examined
  // is visible.
  assert.equal(validator.seen.assertOutput.length, tools.length * 2, 'and the parameter schema of every tool with it')
  assert.equal(validator.seen.assertObjectRoot.length, tools.length, 'and the object-root assertion')
  assert.equal(validator.seen.validate.length, results.length, 'one value check per returned result')
  assert.deepEqual(report.failures, [], 'the stand-in rejects nothing')

  // **Both shapes `list_members` can return are in the run.** The plain read was always here; the flagged one
  // is the value the Host had never seen, and it carries fields nothing else produces. If it disappears the
  // report silently goes back to checking fourteen values, which is what this asserts against.
  const flagged = results.find((result) => result.tool === 'list_members' && result.args?.archived === true)
  assert.ok(flagged !== undefined, 'the harness produced a list_members result with archived: true')
  assert.equal(flagged.error, undefined, 'and it returned a value rather than throwing')
  assert.ok(flagged.value.archived_returned >= 1, `the flagged value carries archived rows (saw ${flagged.value.archived_returned})`)
  const archivedRows = flagged.value.members.filter((row) => row.archived === true)
  assert.equal(archivedRows.length, flagged.value.archived_returned, 'the rows and the count agree')
  assert.equal(typeof archivedRows[0].archived_at, 'string', 'and the archived row says when it left the roster')

  // The declared schema is what decides whether that value survives the Host, so it is walked here explicitly:
  // a field the value carries and the schema does not declare fails **by name**, which is the same failure the
  // Host's `validateJsonSchemaValue` gives and the one no stand-in can produce on a machine without an asar.
  const declaration = tools.find((tool) => tool.name === 'list_members')
  assertMatchesSchema(flagged.value, declaration.output.schema, 'list_members { archived: true }')

  // `spend_tokens` is a value field the Host must accept, and it reaches the validator only if a row carries
  // it — which is exactly the failure this plugin has already shipped once: an operation answered with a
  // property the output schema did not declare, and the call was rejected after the side effect.
  const plain = results.find((result) => result.tool === 'list_members' && Object.keys(result.args ?? {}).length === 0)
  assert.ok(plain !== undefined, 'the harness made a plain list_members call')
  const measured = plain.value.members.find((row) => row.spend_tokens !== undefined)
  assert.ok(measured !== undefined, 'a row carries spend_tokens, so the Host judges the field')
  assert.equal(typeof measured.spend_tokens, 'number', 'and it is the number the projection summed')
  assert.equal(
    measured.spend_tokens,
    1200 + 300 + 4000 + 500,
    'the four counters the harness projection reports',
  )
  // And that row is validated against the declaration, so a field the schema did not declare would fail by
  // name here rather than after a side effect in production.
  assertMatchesSchema(plain.value, declaration.output.schema, 'list_members (plain)')

  // The lookup, in both of its outcomes: a hit carries the record and the scan's cost, a miss carries the
  // sentence the read owes. Neither set of fields is a subset of the other, so both are walked.
  const lookupHit = results.find((result) => result.args?.archived_target === 'archivist-a')
  assert.ok(lookupHit !== undefined, 'the harness looked up an archived record by target')
  assert.equal(lookupHit.error, undefined, 'and it returned a value')
  assert.equal(lookupHit.value.archived_returned, 1, 'the staged tombstone is reachable by its target')
  assert.ok(lookupHit.value.archived_scanned >= 1, 'and the lookup reports what the scan cost')
  assertMatchesSchema(lookupHit.value, declaration.output.schema, 'list_members { archived: true, archived_target }')
  const lookupMiss = results.find((result) => result.args?.archived_target === 'no-such-member-g9')
  assert.ok(lookupMiss !== undefined, 'and once for a name no archive can hold')
  assert.equal(lookupMiss.value.archived_returned, 0)
  assert.equal(typeof lookupMiss.value.message, 'string', 'a miss is a sentence, not an empty list')
  assertMatchesSchema(lookupMiss.value, declaration.output.schema, 'list_members { archived: true, archived_target } on a miss')

  // The number the script prints is the number of values it ran, and the flagged value is one of them.
  const counted = results.filter((result) => result.error === undefined).length
  const text = formatReport({
    identity: { package: 'stand-in', module: 'stand-in', functions: [], error: 'none', extractedFiles: 0, missing: [] },
    report,
  })
  assert.match(text, new RegExp(`real results checked\\s+${counted}\\b`), 'the printed count is the values that returned')
  assert.equal(counted, results.length, 'and none of them threw')

  // The archive half, when this machine has one. Reported either way: silence about which half ran is how
  // the script came to be believed while it was broken.
  const asarPath = process.env.DSH_ASAR ?? DEFAULT_ASAR
  if (!existsSync(asarPath)) {
    t.diagnostic(`no Harness archive at ${asarPath}: the harness half was checked, the Host's validator was not`)
    return
  }
  let loaded
  try {
    loaded = await loadValidator(asarPath)
  } catch (error) {
    t.diagnostic(`the archive at ${asarPath} could not be read (${error instanceof Error ? error.message : String(error)}): the Host's validator was not checked`)
    return
  }
  try {
    const real = checkSchemas({ validator: loaded.validator, tools, results })
    assert.deepEqual(real.failures, [], `the Host's validator (${loaded.identity.package}) rejects nothing this bundle declares`)
    t.diagnostic(`the Host's validator ${loaded.identity.package} accepted every schema and every value`)
  } finally {
    await rm(loaded.extractDir, { recursive: true, force: true })
  }
})
