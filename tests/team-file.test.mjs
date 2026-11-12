import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { handoffPrompt, handoffTemplate, spawnMember } from '../actions.js'
import { DEFINITION_DIR, TEAM_FILE, parseDefinition, parseTeamFile, scanDefinitions } from '../definitions.js'
import { readRoster } from '../roster.js'
import { memoryTable } from './memory-table.mjs'

/**
 * A context fake carrying what a spawn and the filesystem read need. `cwd` mounts the
 * `workingDirectory` service; omitting it is a profile without that service, which is the shape a
 * pre-v0.19 profile has.
 */
function fakeCtx({ cwd, ensureFails = false } = {}) {
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
    get: (name) => {
      if (name !== 'workingDirectory' || cwd === undefined) return undefined
      return {
        ensure: async () => {
          if (ensureFails) throw new Error('the directory does not resolve')
          return cwd
        },
      }
    },
    started,
  }
}

const lead = { id: 'lead-1', status: 'idle', session: { id: 'lead-1', header: {} } }

const hooks = () => ({ filter: { invalidate() {} }, slots: { refresh: async () => {} } })

const call = (ctx, table, extra = {}) => ({
  ctx,
  table,
  leadSessionId: 'lead-1',
  leadAgent: lead,
  dataDir: '/tmp/dsh-team-test',
  hooks: hooks(),
  ...extra,
})

/** A working directory holding the `team/` directory, and one file writer for it. */
async function workspace() {
  const cwd = await mkdtemp(join(tmpdir(), 'dsh-team-team-file-'))
  const dir = join(cwd, DEFINITION_DIR)
  await mkdir(dir, { recursive: true })
  const write = async (file, text) => writeFile(join(dir, file), text, 'utf8')
  return { cwd, dir, write }
}

const firstReviewer = (ctx, table) => spawnMember(call(ctx, table, {
  name: 'reviewer',
  label: 'Check the diff',
  prompt: 'Start on the parser.',
  assignment: 'Finish the parser unit tests.',
}))

test('the team file outranks the stored template, and the read reports the source', async () => {
  const { cwd, dir, write } = await workspace()
  const table = memoryTable()
  const ctx = fakeCtx({ cwd })
  // The store is written first, while no file exists. Then the file appears and takes over.
  await handoffTemplate({ ctx, table, leadSessionId: 'lead-1', leadAgent: lead, template: 'Stored: {assignment}' })
  await write(TEAM_FILE, '---\n---\nFrom the file: {predecessor} -> {successor}. {assignment}\n')

  const read = await handoffTemplate({ ctx, table, leadSessionId: 'lead-1', leadAgent: lead })
  assert.equal(read.source, 'file', 'the file is the source while it exists')
  assert.equal(read.template, 'From the file: {predecessor} -> {successor}. {assignment}')
  assert.equal(read.file, join(dir, TEAM_FILE))
  assert.equal(read.stored, true, 'the stored template is still on the record, reported as shadowed')
  assert.match(read.message, /team file/)
  assert.match(read.message, /shadowed/)

  await firstReviewer(ctx, table)
  await spawnMember(call(ctx, table, { replace: 'reviewer', label: 'Check the diff', prompt: 'Continue.' }))
  assert.match(ctx.started.at(-1).prompt[0].text, /^From the file: reviewer -> reviewer-g2\./)
  assert.match(ctx.started.at(-1).prompt[0].text, /Finish the parser unit tests\./)
  assert.ok(!ctx.started.at(-1).prompt[0].text.includes('Stored:'), 'the shadowed template never renders')
})

test('a store write and a clear are refused while the file exists, naming the file to edit', async () => {
  const { cwd, write } = await workspace()
  const table = memoryTable()
  const ctx = fakeCtx({ cwd })
  await write(TEAM_FILE, '---\n---\nFile: {assignment}\n')

  await assert.rejects(
    () => handoffTemplate({ ctx, table, leadSessionId: 'lead-1', leadAgent: lead, template: 'Stored: {assignment}' }),
    (error) => error.message.includes(TEAM_FILE)
      && error.message.includes('is in effect')
      && error.message.includes('Edit that file'),
  )
  assert.equal(readRoster(table, 'lead-1').handoffTemplate, undefined, 'a refused store writes nothing')

  await assert.rejects(
    () => handoffTemplate({ ctx, table, leadSessionId: 'lead-1', leadAgent: lead, template: '' }),
    (error) => error.message.includes('handoff_template') && error.message.includes('Edit that file'),
  )
  assert.equal(readRoster(table, 'lead-1').handoffTemplate, undefined, 'the clear wrote nothing either')
})

test('the file goes through the placeholder rules, and a broken file falls back to the stored template', async () => {
  const { cwd, write } = await workspace()
  const table = memoryTable()
  const ctx = fakeCtx({ cwd })
  await handoffTemplate({ ctx, table, leadSessionId: 'lead-1', leadAgent: lead, template: 'Stored: {assignment}' })
  await write(TEAM_FILE, '---\n---\nWhat it was doing: {asignment}\n')

  const badToken = await handoffTemplate({ ctx, table, leadSessionId: 'lead-1', leadAgent: lead })
  assert.equal(badToken.source, 'stored', 'a file that cannot render does not shadow the stored template')
  assert.equal(badToken.template, 'Stored: {assignment}')
  assert.equal(badToken.file, join(cwd, DEFINITION_DIR, TEAM_FILE), 'the read still names the file')
  assert.match(badToken.file_problem, /\{asignment\}/)

  await write(TEAM_FILE, '---\n---\nYou are {successor}. Do your best.\n')
  const noAssignment = await handoffTemplate({ ctx, table, leadSessionId: 'lead-1', leadAgent: lead })
  assert.equal(noAssignment.source, 'stored')
  assert.match(noAssignment.file_problem, /must reference \{assignment\}/)

  // A placeholder the parser never sees cannot reach a child: the composition still uses the store.
  await firstReviewer(ctx, table)
  await spawnMember(call(ctx, table, { replace: 'reviewer', label: 'Check the diff', prompt: 'Continue.' }))
  assert.equal(ctx.started.at(-1).prompt[0].text.split('\n')[0], 'Stored: Finish the parser unit tests.')
})

test('a field in the team file frontmatter is refused by name, with its line', async () => {
  const { cwd, write } = await workspace()
  const table = memoryTable()
  const ctx = fakeCtx({ cwd })
  await write(TEAM_FILE, '---\nlabel: Review the diff\n---\nBody: {assignment}\n')

  const read = await handoffTemplate({ ctx, table, leadSessionId: 'lead-1', leadAgent: lead })
  assert.equal(read.source, 'builtin')
  assert.equal(read.file_problem, `line 2: unknown field "label"; the team file's frontmatter is reserved for team settings and accepts none yet; put the handoff template in the body`)

  const parsed = parseTeamFile('---\nlabel: x\n---\nBody: {assignment}\n', TEAM_FILE)
  assert.equal(parsed.problem.line, 2)
  assert.match(parsed.problem.problem, /unknown field "label"/)
})

test('team.md is reserved, so the definition scan never mistakes it for a member', async () => {
  const { dir, write } = await workspace()
  await write(TEAM_FILE, '---\n---\nHandoff: {assignment}\n')
  await write('reviewer.md', '---\nname: reviewer\nlabel: Check the diff\n---\nReview.\n')
  // A member may still declare the identity `team`; only the filename is reserved.
  await write('lead.md', '---\nname: team\nlabel: Run the team\n---\nLead the work.\n')

  const scan = await scanDefinitions(dir)
  assert.deepEqual([...scan.definitions.keys()].sort(), ['reviewer', 'team'])
  assert.deepEqual(scan.problems, [], 'the team file is not reported as an invalid definition')

  // The same `team.md` text would fail as a member definition, which is why the scan skips it.
  const asDefinition = parseDefinition('---\n---\nHandoff: {assignment}\n', TEAM_FILE)
  assert.match(asDefinition.problem.problem, /declares no "name"/)
  assert.equal(parseTeamFile('---\n---\nHandoff: {assignment}\n', TEAM_FILE).team.template, 'Handoff: {assignment}')
})

test('a profile with no team file renders the built-in brief byte for byte', async () => {
  const { cwd } = await workspace()
  const table = memoryTable()
  const ctx = fakeCtx({ cwd })
  const read = await handoffTemplate({ ctx, table, leadSessionId: 'lead-1', leadAgent: lead })
  assert.equal(read.source, 'builtin')
  assert.equal(read.template, '')
  assert.equal(read.stored, false)
  assert.equal(read.file, undefined, 'no file exists, so no path is reported')

  const prompt = handoffPrompt({
    successor: 'reviewer-g2',
    predecessor: {
      name: 'reviewer',
      generation: 1,
      label: 'Check the diff',
      assignment: 'Finish the parser unit tests.',
    },
    prompt: 'Continue with the cache change.',
  })
  assert.equal(prompt, [
    'You are reviewer-g2, the successor of reviewer. reviewer has been retired and is gone; it cannot be messaged.',
    'Its role was: Check the diff.',
    'What it was doing: Finish the parser unit tests.',
    'Its unfinished work is still on the shared team task board under the name "reviewer": take those tasks over instead of redoing finished work, and ask the Lead for their ids if you cannot read the board.',
    'Your task: Continue with the cache change.',
  ].join('\n'))
})

test('a working directory that cannot be resolved leaves the store usable, as before', async () => {
  const { cwd } = await workspace()
  const table = memoryTable()
  const ctx = fakeCtx({ cwd, ensureFails: true })
  const stored = await handoffTemplate({ ctx, table, leadSessionId: 'lead-1', leadAgent: lead, template: 'Stored: {assignment}' })
  assert.equal(stored.source, 'stored')
  assert.equal(stored.file, undefined)
  assert.equal((await handoffTemplate({ ctx, table, leadSessionId: 'lead-1', leadAgent: lead })).template, 'Stored: {assignment}')
})
