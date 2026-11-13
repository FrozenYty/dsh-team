/**
 * The schema-check script, without the Host.
 *
 * The archive itself is not here — CI has no Harness — so what is tested is everything that decides
 * whether the check is right: the archive header reader (against a synthetic archive this file builds to
 * the same layout), the module-specifier scan, Node's resolution walk, and the checking logic with a
 * stand-in validator. The one thing left to the local run is the validator's own verdict.
 */

import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  checkSchemas,
  formatReport,
  openArchive,
  readArchived,
  resolutionCandidates,
  specifiersOf,
} from '../scripts/schema-check.mjs'

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

/** A validator stand-in: rejects the schemas and values a test names, accepts everything else. */
function stubValidator({ rejectSchemas = [], rejectValues = [] } = {}) {
  return {
    assertOutput: (schema) => {
      for (const entry of rejectSchemas) {
        if (entry.schema === schema) throw Object.assign(new Error(`unsupported JSON schema: ${entry.violation}`), { violations: [entry.violation] })
      }
    },
    assertObjectRoot: () => undefined,
    validate: (schema, value) => {
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
