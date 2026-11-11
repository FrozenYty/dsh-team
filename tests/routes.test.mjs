import assert from 'node:assert/strict'
import { test } from 'node:test'

import { listMembers, retireMember, restoreMember } from '../actions.js'
import {
  API_PREFIX,
  buildSessionState,
  buildSessionsIndex,
  createApiHandler,
  isLoopbackAddress,
  rejectedRequest,
  resolveRoute,
} from '../routes.js'

const WRITTEN_AT = '2026-11-11T10:00:00.000Z'
const LATER_AT = '2026-11-11T11:00:00.000Z'

/** One member record, as the roster stores it. */
const member = (overrides = {}) => ({
  memberId: 'member-1',
  name: 'reviewer',
  generation: 1,
  childId: 'child-1',
  phase: 'active',
  label: 'Review the diff',
  createdAt: WRITTEN_AT,
  ...overrides,
})

/** One Lead's roster record. */
const roster = (leadSessionId = 'lead-1', members = [member()], updatedAt = WRITTEN_AT) => ({
  leadSessionId,
  members,
  updatedAt,
})

/** An in-memory stand-in for a storage-domain table. */
function fakeTable(seed = {}) {
  const records = new Map(Object.entries(seed))
  return {
    get: (key) => records.get(key),
    put: async (key, value) => {
      records.set(key, value)
    },
    entries: () => records.entries(),
  }
}

/** The Host context a state read needs: live Agents, the service lookup and the token meter. */
function fakeContext({ agents = new Map(), services = {} } = {}) {
  return {
    agents: {
      get: (id) => agents.get(id),
      list: () => [...agents.values()],
    },
    agentTeams: {
      tryMembership: () => ({ role: 'lead' }),
      listMembers: () => [],
    },
    tokenMeter: {
      contextPressure: () => ({ pressureTokens: 240000, contextWindow: 1048576 }),
    },
    subagents: {
      drainChildren: async () => undefined,
    },
    get: (name) => services[name],
  }
}

/** A stand-in for the two host-side effects a mutation refreshes. */
const fakeHooks = () => ({
  filter: { invalidate: () => undefined },
  slots: { refresh: async () => 0 },
})

/** A node request stand-in: a socket address, headers, and an async body stream. */
function fakeRequest({ method = 'GET', url = '/', address = '127.0.0.1', headers = {}, body } = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(body)]
  return {
    method,
    url,
    headers: { host: '127.0.0.1:3080', ...headers },
    socket: { remoteAddress: address },
    destroyed: false,
    destroy() {
      this.destroyed = true
    },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
}

/** A node response stand-in that records the status, headers and JSON body. */
function fakeResponse() {
  return {
    status: undefined,
    headers: undefined,
    body: undefined,
    writeHead(status, headers) {
      this.status = status
      this.headers = headers
    },
    end(body) {
      this.body = body === undefined ? undefined : JSON.parse(body)
    },
  }
}

/** The handler under test, wired exactly as `index.js` wires it. */
const makeHandler = (ctx, table) => createApiHandler({
  ctx,
  store: Promise.resolve(table),
  dataDir: 'test-data',
  hooks: fakeHooks(),
  log: () => undefined,
})

test('the state carries exactly one Lead Session roster with its member rows', () => {
  const ctx = fakeContext({
    agents: new Map([
      ['lead-1', { session: { id: 'lead-1' }, status: 'idle' }],
      ['child-1', { session: { id: 'child-1' }, status: 'idle' }],
    ]),
  })
  const table = fakeTable({
    'lead-1': roster(),
    'lead-2': roster('lead-2', [member({ memberId: 'member-2', childId: 'child-2', name: 'tester' })]),
  })

  const state = buildSessionState({ ctx, table, leadSessionId: 'lead-1' })

  assert.equal(state.leadSessionId, 'lead-1')
  assert.equal(state.leadLive, true)
  assert.equal(state.exists, true)
  assert.equal(state.updatedAt, WRITTEN_AT)
  assert.equal(state.members.length, 1, 'the other roster never appears in this payload')

  const row = state.members[0]
  assert.equal(row.target, 'reviewer')
  assert.equal(row.phase, 'active')
  assert.equal(row.generation, 1)
  assert.equal(row.status, 'idle')
  assert.equal(row.resident, true)
  assert.equal(row.pressure_tokens, 240000)
  assert.equal(row.context_window, 1048576)
})

test('a session without a roster answers exists: false instead of an empty page', () => {
  const state = buildSessionState({ ctx: fakeContext(), table: fakeTable({ 'lead-1': roster() }), leadSessionId: 'lead-9' })
  assert.deepEqual(state, { leadSessionId: 'lead-9', leadLive: false, exists: false, members: [] })
})

test('the sessions index lists counts only, never member rows', () => {
  const ctx = fakeContext({ agents: new Map([['lead-2', { session: { id: 'lead-2' }, status: 'idle' }]]) })
  const table = fakeTable({
    'lead-1': roster('lead-1', [
      member(),
      member({ memberId: 'member-2', name: 'retired-one', childId: 'child-2', phase: 'retired' }),
    ]),
    'lead-2': roster('lead-2', [member({ memberId: 'member-3', childId: 'child-3', name: 'tester' })], LATER_AT),
  })

  const index = buildSessionsIndex({ ctx, table })

  assert.equal(index.sessions.length, 2)
  const live = index.sessions[0]
  assert.deepEqual(live, { leadSessionId: 'lead-2', memberCount: 1, liveCount: 1, leadLive: true, updatedAt: LATER_AT })
  assert.equal(live.members, undefined, 'the index carries no member rows')
  assert.equal(live.memberCount, 1, 'the index carries a count instead')

  const offline = index.sessions[1]
  assert.deepEqual(offline, {
    leadSessionId: 'lead-1',
    memberCount: 2,
    liveCount: 1,
    leadLive: false,
    updatedAt: WRITTEN_AT,
  })
})

test('the index is ordered live Leads first, then newest write, and that order is the default pick', () => {
  const ctx = fakeContext({ agents: new Map([['lead-b', { session: { id: 'lead-b' } }]]) })
  const table = fakeTable({
    'lead-a': roster('lead-a', [member()], WRITTEN_AT),
    'lead-b': roster('lead-b', [member()], '2026-11-10T09:00:00.000Z'),
    'lead-c': roster('lead-c', [member()], LATER_AT),
  })

  const index = buildSessionsIndex({ ctx, table })
  assert.deepEqual(index.sessions.map((row) => row.leadSessionId), ['lead-b', 'lead-c', 'lead-a'])
  assert.equal(index.selectedLeadSessionId, 'lead-b', 'no current-session signal: the live Lead wins')
})

test('a named current session wins the selection even when it has no roster', () => {
  const ctx = fakeContext()
  const table = fakeTable({ 'lead-1': roster('lead-1') })

  const named = buildSessionsIndex({ ctx, table, currentSessionId: 'lead-9' })
  assert.equal(named.selectedLeadSessionId, 'lead-9', 'the panel must be able to say this session has none')
  assert.deepEqual(named.sessions.map((row) => row.leadSessionId), ['lead-1'])

  const present = buildSessionsIndex({ ctx, table, currentSessionId: 'lead-1' })
  assert.equal(present.selectedLeadSessionId, 'lead-1')

  const blank = buildSessionsIndex({ ctx, table, currentSessionId: '  ' })
  assert.equal(blank.selectedLeadSessionId, 'lead-1', 'a blank parameter is not a signal')
})

test('an empty store reports an empty index with no selection', () => {
  const index = buildSessionsIndex({ ctx: fakeContext(), table: fakeTable() })
  assert.deepEqual(index, { sessions: [] })
  assert.equal(index.selectedLeadSessionId, undefined)
})

test('the route table matches path and method exactly', () => {
  assert.deepEqual(resolveRoute('GET', `${API_PREFIX}/state`), { name: 'state' })
  assert.deepEqual(resolveRoute('GET', `${API_PREFIX}/sessions`), { name: 'sessions' })
  assert.deepEqual(resolveRoute('POST', `${API_PREFIX}/retire`), { name: 'retire' })
  assert.deepEqual(resolveRoute('POST', `${API_PREFIX}/restore`), { name: 'restore' })
  assert.deepEqual(resolveRoute('GET', `${API_PREFIX}/retire`), { methodNotAllowed: true, allow: ['POST'] })
  assert.deepEqual(resolveRoute('POST', `${API_PREFIX}/sessions`), { methodNotAllowed: true, allow: ['GET'] })
  assert.deepEqual(resolveRoute('HEAD', `${API_PREFIX}/state`), { methodNotAllowed: true, allow: ['GET'] })
  assert.equal(resolveRoute('GET', API_PREFIX), undefined)
  assert.equal(resolveRoute('GET', `${API_PREFIX}/state/extra`), undefined)
  assert.equal(resolveRoute('GET', '/api/team-rosters/state'), undefined)
})

test('only the loopback interface may reach the bridge', () => {
  assert.equal(isLoopbackAddress('127.0.0.1'), true)
  assert.equal(isLoopbackAddress('127.8.9.10'), true)
  assert.equal(isLoopbackAddress('::1'), true)
  assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true)
  assert.equal(isLoopbackAddress('192.168.1.20'), false)
  assert.equal(isLoopbackAddress(undefined), false)

  assert.equal(rejectedRequest(fakeRequest()), undefined)
  assert.equal(rejectedRequest(fakeRequest({ address: '::1' })), undefined)
  assert.match(rejectedRequest(fakeRequest({ address: '10.0.0.5' })), /local machine/)
  assert.match(rejectedRequest({ headers: {} }), /local machine/)
})

test('a cross-origin request is refused even from loopback', () => {
  const sameOrigin = fakeRequest({ headers: { origin: 'http://127.0.0.1:3080' } })
  assert.equal(rejectedRequest(sameOrigin), undefined)

  const otherOrigin = fakeRequest({ headers: { origin: 'https://evil.example' } })
  assert.match(rejectedRequest(otherOrigin), /another origin/)

  const opaqueOrigin = fakeRequest({ headers: { origin: 'null' } })
  assert.match(rejectedRequest(opaqueOrigin), /another origin/)

  const crossSite = fakeRequest({ headers: { 'sec-fetch-site': 'cross-site' } })
  assert.match(rejectedRequest(crossSite), /Cross-site/)
})

test('the handler serves one session state and the picker index as JSON', async () => {
  const table = fakeTable({ 'lead-1': roster() })
  const handler = makeHandler(fakeContext(), table)

  const state = fakeResponse()
  await handler(fakeRequest({ url: `${API_PREFIX}/state?leadSessionId=lead-1` }), state)
  assert.equal(state.status, 200)
  assert.equal(state.headers['content-type'], 'application/json; charset=utf-8')
  assert.equal(state.body.leadSessionId, 'lead-1')
  assert.equal(state.body.members.length, 1)

  const index = fakeResponse()
  await handler(fakeRequest({ url: `${API_PREFIX}/sessions?currentSessionId=lead-9` }), index)
  assert.equal(index.status, 200)
  assert.equal(index.body.sessions.length, 1)
  assert.equal(index.body.sessions[0].members, undefined)
  assert.equal(index.body.selectedLeadSessionId, 'lead-9')
})

test('the handler refuses a state read without a Lead Session id', async () => {
  const handler = makeHandler(fakeContext(), fakeTable({ 'lead-1': roster() }))

  const missing = fakeResponse()
  await handler(fakeRequest({ url: `${API_PREFIX}/state` }), missing)
  assert.equal(missing.status, 400)
  assert.match(missing.body.error, /leadSessionId is required/)

  const blank = fakeResponse()
  await handler(fakeRequest({ url: `${API_PREFIX}/state?leadSessionId=` }), blank)
  assert.equal(blank.status, 400)

  const unknown = fakeResponse()
  await handler(fakeRequest({ url: `${API_PREFIX}/state?leadSessionId=lead-9` }), unknown)
  assert.equal(unknown.status, 200, 'an unknown session is an answer, not a failure')
  assert.equal(unknown.body.exists, false)
  assert.deepEqual(unknown.body.members, [])
})

test('the handler refuses a non-loopback caller, a cross-origin caller, and an oversized body', async () => {
  const handler = makeHandler(fakeContext(), fakeTable({ 'lead-1': roster() }))

  const remote = fakeResponse()
  await handler(fakeRequest({ url: `${API_PREFIX}/state?leadSessionId=lead-1`, address: '192.168.1.20' }), remote)
  assert.equal(remote.status, 403)

  const crossOrigin = fakeResponse()
  await handler(fakeRequest({
    url: `${API_PREFIX}/state?leadSessionId=lead-1`,
    headers: { origin: 'https://evil.example' },
  }), crossOrigin)
  assert.equal(crossOrigin.status, 403)

  const oversized = fakeResponse()
  await handler(fakeRequest({
    method: 'POST',
    url: `${API_PREFIX}/retire`,
    headers: { 'content-length': String(65 * 1024) },
    body: JSON.stringify({ leadSessionId: 'lead-1', target: 'reviewer' }),
  }), oversized)
  assert.equal(oversized.status, 413)
})

test('the handler answers an unknown path, a wrong method and a malformed body with a status', async () => {
  const handler = makeHandler(fakeContext(), fakeTable({ 'lead-1': roster() }))

  const missing = fakeResponse()
  await handler(fakeRequest({ url: `${API_PREFIX}/nope` }), missing)
  assert.equal(missing.status, 404)

  const wrongMethod = fakeResponse()
  await handler(fakeRequest({ method: 'GET', url: `${API_PREFIX}/retire` }), wrongMethod)
  assert.equal(wrongMethod.status, 405)
  assert.equal(wrongMethod.headers.allow, 'POST')

  const badJson = fakeResponse()
  await handler(fakeRequest({
    method: 'POST',
    url: `${API_PREFIX}/retire`,
    body: '{not json',
  }), badJson)
  assert.equal(badJson.status, 400)

  const missingFields = fakeResponse()
  await handler(fakeRequest({
    method: 'POST',
    url: `${API_PREFIX}/retire`,
    body: JSON.stringify({ target: 'reviewer' }),
  }), missingFields)
  assert.equal(missingFields.status, 400)
})

test('retiring without a live Lead returns a clear failure, not a stack trace', async () => {
  const ctx = fakeContext()
  const table = fakeTable({ 'lead-1': roster() })

  const direct = await retireMember({
    ctx,
    table,
    leadSessionId: 'lead-1',
    leadAgent: undefined,
    dataDir: 'test-data',
    hooks: fakeHooks(),
    target: 'reviewer',
  })
  assert.equal(direct.retired, false)
  assert.match(direct.message, /not live/)
  assert.equal(table.get('lead-1').members[0].phase, 'active', 'nothing changed')

  await assert.rejects(listMembers({ ctx, table, leadSessionId: 'lead-1', leadAgent: undefined }), /not live/)

  const response = fakeResponse()
  await makeHandler(ctx, table)(fakeRequest({
    method: 'POST',
    url: `${API_PREFIX}/retire`,
    body: JSON.stringify({ leadSessionId: 'lead-1', target: 'reviewer' }),
  }), response)
  assert.equal(response.status, 200)
  assert.equal(response.body.retired, false)
  assert.match(response.body.message, /not live/)
})

test('the route and the tool change the roster through the same operation', async () => {
  const leadAgent = { session: { id: 'lead-1' } }
  const ctx = fakeContext({ agents: new Map([['lead-1', leadAgent]]) })
  const table = fakeTable({ 'lead-1': roster() })
  const response = fakeResponse()
  await makeHandler(ctx, table)(fakeRequest({
    method: 'POST',
    url: `${API_PREFIX}/retire`,
    body: JSON.stringify({ leadSessionId: 'lead-1', target: 'reviewer', reason: 'no longer needed' }),
  }), response)

  assert.equal(response.status, 200)
  assert.equal(response.body.retired, true)
  assert.equal(response.body.drained, true)
  assert.equal(response.body.trashed, false, 'no persistence service in this fake')
  const stored = table.get('lead-1').members[0]
  assert.equal(stored.phase, 'retired')
  assert.equal(stored.retireReason, 'no longer needed')

  // Restore needs no live Lead: it is a filesystem move plus a record write.
  const restored = await restoreMember({ ctx, table, leadSessionId: 'lead-1', target: 'reviewer', hooks: fakeHooks() })
  assert.equal(restored.restored, false, 'there is no recorded artifact to move back')
  assert.match(restored.message, /no workspace service/)
})
