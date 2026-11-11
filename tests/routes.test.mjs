import assert from 'node:assert/strict'
import { test } from 'node:test'

import { listMembers, retireMember, restoreMember } from '../actions.js'
import {
  API_PREFIX,
  buildState,
  createApiHandler,
  isLoopbackAddress,
  rejectedRequest,
  resolveRoute,
} from '../routes.js'

const WRITTEN_AT = '2026-11-11T10:00:00.000Z'

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

test('the state groups rosters by Lead Session and reports live members', () => {
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

  const state = buildState({ ctx, table })

  assert.equal(state.version, Date.parse(WRITTEN_AT))
  assert.deepEqual(state.rosters.map((entry) => entry.leadSessionId), ['lead-1', 'lead-2'], 'live Leads sort first')
  assert.equal(state.rosters[0].leadLive, true)
  assert.equal(state.rosters[1].leadLive, false)

  const row = state.rosters[0].members[0]
  assert.equal(row.target, 'reviewer')
  assert.equal(row.phase, 'active')
  assert.equal(row.generation, 1)
  assert.equal(row.status, 'idle')
  assert.equal(row.resident, true)
  assert.equal(row.pressure_tokens, 240000)
  assert.equal(row.context_window, 1048576)
})

test('an empty store reports an empty roster list at version zero', () => {
  const state = buildState({ ctx: fakeContext(), table: fakeTable() })
  assert.deepEqual(state, { rosters: [], version: 0 })
})

test('the route table matches path and method exactly', () => {
  assert.deepEqual(resolveRoute('GET', `${API_PREFIX}/state`), { name: 'state' })
  assert.deepEqual(resolveRoute('POST', `${API_PREFIX}/retire`), { name: 'retire' })
  assert.deepEqual(resolveRoute('POST', `${API_PREFIX}/restore`), { name: 'restore' })
  assert.deepEqual(resolveRoute('GET', `${API_PREFIX}/retire`), { methodNotAllowed: true, allow: ['POST'] })
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

test('the handler serves the state as JSON', async () => {
  const table = fakeTable({ 'lead-1': roster() })
  const response = fakeResponse()
  await makeHandler(fakeContext(), table)(fakeRequest({ url: `${API_PREFIX}/state` }), response)

  assert.equal(response.status, 200)
  assert.equal(response.headers['content-type'], 'application/json; charset=utf-8')
  assert.equal(response.body.rosters.length, 1)
})

test('the handler refuses a non-loopback caller, a cross-origin caller, and an oversized body', async () => {
  const handler = makeHandler(fakeContext(), fakeTable({ 'lead-1': roster() }))

  const remote = fakeResponse()
  await handler(fakeRequest({ url: `${API_PREFIX}/state`, address: '192.168.1.20' }), remote)
  assert.equal(remote.status, 403)

  const crossOrigin = fakeResponse()
  await handler(fakeRequest({ url: `${API_PREFIX}/state`, headers: { origin: 'https://evil.example' } }), crossOrigin)
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
