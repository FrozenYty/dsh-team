/**
 * The templates this bundle ships, and the chain that lets a workspace override one.
 *
 * A shipped template is a starting point: it declares the role — `name`, `label`, `assignment` — and never
 * the route, because a bundled default model would pin a user's bill to whatever was current the day the
 * file was written. A workspace definition of the same name wins, and the older `team/` directory is still
 * read so a profile that kept its roles there does not lose them.
 */

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { spawnMember } from '../actions.js'
import { DEFINITION_DIR, WORKSPACE_DEFINITION_DIR, parseDefinition } from '../definitions.js'
import { memoryTable } from './memory-table.mjs'

/** The shipped directory, resolved the way `definitions.js` resolves it: beside the module. */
const SHIPPED_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'templates', 'definitions')

/** The five roles the owner asked for: one per standing member this team runs on. */
const ROLES = ['implementer', 'researcher', 'reviewer', 'scribe', 'verifier']

/** The fields a shipped template may declare. The route belongs to whoever starts the member. */
const TEMPLATE_FIELDS = ['assignment', 'label', 'name']

/** A context fake carrying what a definition spawn reads, plus the `workingDirectory` service. */
function fakeCtx({ cwd } = {}) {
  const started = []
  return {
    agentTeams: { listMembers: () => [] },
    subagents: {
      listDescendants: async () => [],
      startActivation: async (spec) => {
        started.push(spec.request)
        return { childId: spec.childId }
      },
      drainChildren: async () => {},
      sendMessage: async () => 'message-1',
      interrupt: () => {},
    },
    agents: { get: () => undefined },
    get: (name) => (name === 'workingDirectory' && cwd !== undefined ? { ensure: async () => cwd } : undefined),
    started,
  }
}

const lead = { id: 'lead-1', status: 'idle', session: { id: 'lead-1', header: {} } }

const call = (ctx, extra = {}) => ({
  ctx,
  table: memoryTable(),
  leadSessionId: 'lead-1',
  leadAgent: lead,
  dataDir: '/tmp/dsh-team-test',
  hooks: { filter: { invalidate() {} }, slots: { refresh: async () => {} } },
  ...extra,
})

/** A fresh workspace, with the canonical definitions directory and the older `team/` one. */
async function workspace() {
  const cwd = await mkdtemp(join(tmpdir(), 'dsh-team-templates-'))
  const writeIn = async (relative, file, text) => {
    const dir = join(cwd, relative)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, file), text, 'utf8')
  }
  return {
    cwd,
    writeCanonical: (file, text) => writeIn(WORKSPACE_DEFINITION_DIR, file, text),
    writeLegacy: (file, text) => writeIn(DEFINITION_DIR, file, text),
  }
}

/** The body the shipped template of one role carries, trimmed the way the parser trims it. */
async function shippedPrompt(name) {
  const text = await readFile(join(SHIPPED_DIR, `${name}.md`), 'utf8')
  return parseDefinition(text, `${name}.md`).definition.prompt
}

test('every shipped template parses, and declares the role rather than the route', async () => {
  // The directory is the list, not a hardcoded five, so a template added later is covered by this test.
  const files = (await readdir(SHIPPED_DIR)).filter((name) => name.endsWith('.md')).sort()
  assert.deepEqual(files, ROLES.map((name) => `${name}.md`), 'the five standing roles, one file each')

  for (const file of files) {
    const text = await readFile(join(SHIPPED_DIR, file), 'utf8')
    const parsed = parseDefinition(text, file)
    assert.equal(parsed.problem, undefined, `${file}: parses, so no profile ships a definition it cannot read`)
    const { definition } = parsed
    assert.deepEqual(
      Object.keys(definition.fields).sort(),
      TEMPLATE_FIELDS,
      `${file}: declares name, label and assignment and nothing else — a bundled route would pin a user's bill`,
    )
    assert.equal(definition.name, file.replace(/\.md$/, ''), `${file}: the file is named after the role it declares`)
    assert.ok(definition.prompt.length > 400, `${file}: the body is a brief, not a placeholder`)
    // The two rules this repository keeps relearning. A template that loses them teaches the member the
    // opposite of what every other instruction here says.
    assert.match(definition.prompt, /three parts/, `${file}: the report is three parts`)
    assert.match(definition.prompt, /can fail/, `${file}: a check that can fail, not a feeling`)
  }
})

test('a workspace definition wins over the shipped one of the same name, and the shipped one answers when it is absent', async () => {
  // Absent: the shipped template is the starting point, and it is what the member starts from.
  const bare = await workspace()
  const shipped = await spawnMember(call(fakeCtx({ cwd: bare.cwd }), { definition: 'reviewer' }))
  assert.equal(shipped.target, 'reviewer')
  assert.ok(shipped.definition.path.endsWith(join('templates', 'definitions', 'reviewer.md')), 'the shipped file')

  // Present at the canonical location: the workspace file is the one in effect.
  const project = await workspace()
  await project.writeCanonical('reviewer.md', '---\nname: reviewer\nlabel: Our reviewer\nassignment: Review our diffs.\n---\nOur own reviewer body.\n')
  const ctx = fakeCtx({ cwd: project.cwd })
  const own = await spawnMember(call(ctx, { definition: 'reviewer' }))
  assert.equal(own.target, 'reviewer')
  assert.equal(own.label, 'Our reviewer')
  assert.ok(own.definition.path.endsWith(join(WORKSPACE_DEFINITION_DIR, 'reviewer.md')), 'the workspace file, not the shipped one')
  assert.equal(ctx.started[0].prompt[0].text, 'Our own reviewer body.', 'and its body is the prompt that was started')
})

test('a profile that keeps its definitions in team/ still finds them', async () => {
  const legacy = await workspace()
  await legacy.writeLegacy('implementer.md', '---\nname: implementer\nlabel: Our implementer\nassignment: Build our things.\n---\nOur own implementer body.\n')
  const ctx = fakeCtx({ cwd: legacy.cwd })

  const born = await spawnMember(call(ctx, { definition: 'implementer' }))
  assert.equal(born.target, 'implementer')
  assert.equal(born.label, 'Our implementer', 'the old directory is still read, two releases after the move')
  assert.ok(born.definition.path.endsWith(join(DEFINITION_DIR, 'implementer.md')))
  assert.equal(ctx.started[0].prompt[0].text, 'Our own implementer body.')

  // A name only the old directory has is found too, and the shipped templates still fill the rest.
  await legacy.writeLegacy('auditor.md', '---\nname: auditor\nlabel: Auditor\n---\nAudit.\n')
  const auditor = await spawnMember(call(fakeCtx({ cwd: legacy.cwd }), { definition: 'auditor' }))
  assert.equal(auditor.target, 'auditor')
  const missing = await spawnMember(call(fakeCtx({ cwd: legacy.cwd }), { definition: 'verifier' }))
  assert.equal(missing.target, 'verifier', 'and a shipped role the workspace never declared still answers')
})

test('a workspace file that declares a shipped name and is broken refuses it instead of substituting the shipped role', async () => {
  // The author is editing a file that is not in effect; silently starting the shipped role instead would
  // hide that, and the member would run a prompt nobody chose.
  const project = await workspace()
  await project.writeCanonical('reviewer.md', '---\nname: reviewer\nlabel: Our reviewer\nephemeral: true\n---\nOur own reviewer body.\n')

  const result = await spawnMember(call(fakeCtx({ cwd: project.cwd }), { definition: 'reviewer' }))
  assert.equal(result.started, false)
  assert.equal(result.reason, 'definition-invalid')
  assert.ok(result.problems[0].path.endsWith(join(WORKSPACE_DEFINITION_DIR, 'reviewer.md')))
  assert.ok(!result.available.includes('reviewer'), 'the shipped template does not take the name over')
  assert.ok(result.available.includes('scribe'), 'the other shipped starting points are still usable')
})

test('the shipped prompt is what a member starts with when no workspace file claims the name', async () => {
  const bare = await workspace()
  const ctx = fakeCtx({ cwd: bare.cwd })
  await spawnMember(call(ctx, { definition: 'verifier' }))
  assert.equal(ctx.started[0].prompt[0].text, await shippedPrompt('verifier'), 'byte for byte from the bundle')
})
