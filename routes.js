/**
 * The Settings panel's HTTP bridge: a per-session read, the picker's index, and the two mutating
 * operations, over the Host web server.
 *
 * The panel is per-session — one roster at a time — so the per-session payload is the only one that
 * carries member rows. `GET /state?leadSessionId=` answers exactly one roster, and `GET /sessions`
 * answers a counts-only index for the picker. Neither lists Sessions: the roster already knows its Lead
 * Session ids, and the browser joins the index against the session catalog it already subscribes to
 * (`useSessions`), so titles never travel over this bridge and a roster whose Lead Session is closed
 * still reads.
 *
 * `ctx.webServer.register` takes a named route whose `handler` owns the raw node request and response —
 * that is the only shape that can answer a POST, because a `resource` is answered only for GET/HEAD and
 * every other method receives 405. The registered shape is the one the shipped `client-connection`
 * plugin uses for its `/api` route:
 *
 *   webServer.register({ kind: 'prefix', path: '/api/...', handler: (req, res) => { ... } })
 *
 * A route is not behind the Connection fence, so this file is the fence: loopback remote address,
 * same-origin `Origin`/`Sec-Fetch-Site` when a browser attaches them, and a 64 KiB body cap. The mutating
 * operations are the functions in `actions.js` — the same ones the model-facing tools call.
 *
 * No `@deepseek-ai/*` import: a profile-linked bundle cannot resolve those packages (ADR 0002).
 */

import { retireMember, restoreMember, memberRow } from './actions.js'

/** One prefix for every endpoint this panel uses. */
export const API_PREFIX = '/api/team-roster'
/** Cap on a request body; both mutations carry a few hundred bytes at most. */
export const BODY_LIMIT_BYTES = 64 * 1024

/** The four endpoints, in one table so path and method stay together. */
const ROUTES = [
  { path: `${API_PREFIX}/state`, method: 'GET', name: 'state' },
  { path: `${API_PREFIX}/sessions`, method: 'GET', name: 'sessions' },
  { path: `${API_PREFIX}/retire`, method: 'POST', name: 'retire' },
  { path: `${API_PREFIX}/restore`, method: 'POST', name: 'restore' },
]

/** An error that carries the HTTP status it should become. */
class RequestError extends Error {
  constructor(message, status) {
    super(message)
    this.status = status
  }
}

/**
 * Whether an address is the local loopback authority. The bridge is deliberately not reachable from
 * another machine: a remote caller must not be able to retire a team member.
 * @param {unknown} address - `req.socket.remoteAddress`.
 * @returns {boolean} true for IPv4 127/8, `::1`, and their IPv4-mapped text forms.
 */
export function isLoopbackAddress(address) {
  if (typeof address !== 'string') return false
  const zoneAt = address.indexOf('%')
  const bare = (zoneAt === -1 ? address : address.slice(0, zoneAt)).toLowerCase()
  const normalized = bare.startsWith('::ffff:') ? bare.slice('::ffff:'.length) : bare
  return normalized === '::1' || normalized === 'localhost' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(normalized)
}

/**
 * Whether an `Origin` header names the listener the request arrived on.
 * A browser attaches `Origin` to a mutating request; the panel's requests carry the page's own origin,
 * and any other origin is a page this bridge does not serve.
 * @param {string} origin - verbatim `Origin` header.
 * @param {string} host - verbatim `Host` header.
 * @returns {boolean} true only for the same `http(s)` authority.
 */
function isSameAuthorityOrigin(origin, host) {
  let originUrl
  try {
    originUrl = new URL(origin)
  } catch (error) {
    return false
  }
  const scheme = originUrl.protocol === 'https:' ? 'https:' : originUrl.protocol === 'http:' ? 'http:' : undefined
  if (scheme === undefined) return false
  let hostUrl
  try {
    hostUrl = new URL(`${scheme}//${host}`)
  } catch (error) {
    return false
  }
  return originUrl.host === hostUrl.host
}

/**
 * The reason a request must be refused before it reaches an operation, or undefined when it may proceed.
 * @param {{socket?: {remoteAddress?: string}, headers?: Record<string, unknown>}} request - node request.
 * @returns {string|undefined} a human-readable reason for a 403, or undefined.
 */
export function rejectedRequest(request) {
  const address = request?.socket?.remoteAddress
  if (!isLoopbackAddress(address)) return 'This endpoint is served to the local machine only.'
  const headers = request?.headers ?? {}
  if (headers['sec-fetch-site'] === 'cross-site') return 'Cross-site requests are not accepted.'
  const origin = typeof headers.origin === 'string' ? headers.origin : undefined
  if (origin === undefined) return undefined
  const host = typeof headers.host === 'string' ? headers.host : undefined
  if (host === undefined) return 'An Origin header arrived without a Host header.'
  return isSameAuthorityOrigin(origin, host) ? undefined : 'The Origin header belongs to another origin.'
}

/**
 * Match one request against the endpoint table.
 * @param {string} method - HTTP method.
 * @param {string} pathname - request path.
 * @returns {{name: string}|{methodNotAllowed: true, allow: string[]}|undefined} the route, a 405 fact, or
 *   undefined for an unknown path.
 */
export function resolveRoute(method, pathname) {
  const route = ROUTES.find((candidate) => candidate.path === pathname && candidate.method === method)
  if (route !== undefined) return { name: route.name }
  const onPath = ROUTES.filter((candidate) => candidate.path === pathname)
  if (onPath.length === 0) return undefined
  return { methodNotAllowed: true, allow: onPath.map((candidate) => candidate.method) }
}

/**
 * Build the `GET .../state` body for exactly one Lead Session, without listing or probing Sessions.
 * @param {{ctx: object, table: {get: (key: string) => object|undefined}, leadSessionId: string}} request
 * @returns {{leadSessionId: string, leadLive: boolean, exists: boolean, members: object[], updatedAt?: string}}
 *   one roster. `exists: false` is a normal answer, not an error: the panel states plainly that this
 *   session has no roster yet instead of rendering an empty page.
 */
export function buildSessionState({ ctx, table, leadSessionId }) {
  const roster = table.get(leadSessionId)
  const value = {
    leadSessionId,
    leadLive: ctx.agents.get(leadSessionId) !== undefined,
    exists: roster !== undefined,
    members: roster === undefined ? [] : (roster.members ?? []).map((member) => memberRow(ctx, member)),
  }
  if (typeof roster?.updatedAt === 'string') value.updatedAt = roster.updatedAt
  return value
}

/**
 * Build the picker's index: one counts-only row per Lead Session that has a roster, plus the session the
 * panel should open. No member rows and no Session reads — the index stays cheap enough to poll while a
 * roster's Lead Session is closed.
 *
 * Ordering is the documented default rule: live Leads first, then the most recently written roster, then
 * the id ascending. So when the browser has no current-session signal at all, `selectedLeadSessionId`
 * lands on a roster whose Lead is live whenever one exists, and the picker is the way to any other.
 *
 * A named `currentSessionId` always wins, even when it has no roster: that is the session the user is in,
 * and the panel must be able to say so rather than silently showing somebody else's team.
 *
 * @param {{ctx: object, table: {entries: () => Iterable<[string, object]>}, currentSessionId?: string}} request
 * @returns {{sessions: object[], selectedLeadSessionId?: string}} the index and the opening selection.
 */
export function buildSessionsIndex({ ctx, table, currentSessionId }) {
  const entries = []
  for (const [leadSessionId, roster] of table.entries()) {
    const id = String(leadSessionId)
    const members = roster?.members ?? []
    const written = Date.parse(roster?.updatedAt ?? '')
    entries.push({
      leadSessionId: id,
      memberCount: members.length,
      liveCount: members.filter((member) => member?.phase !== 'retired').length,
      leadLive: ctx.agents.get(id) !== undefined,
      written: Number.isFinite(written) ? written : 0,
      updatedAt: typeof roster?.updatedAt === 'string' ? roster.updatedAt : undefined,
    })
  }
  entries.sort((left, right) => Number(right.leadLive) - Number(left.leadLive)
    || right.written - left.written
    || left.leadSessionId.localeCompare(right.leadSessionId))

  const sessions = entries.map((entry) => {
    const row = {
      leadSessionId: entry.leadSessionId,
      memberCount: entry.memberCount,
      liveCount: entry.liveCount,
      leadLive: entry.leadLive,
    }
    if (entry.updatedAt !== undefined) row.updatedAt = entry.updatedAt
    return row
  })

  const named = typeof currentSessionId === 'string' ? currentSessionId.trim() : ''
  const selected = named !== '' ? named : sessions[0]?.leadSessionId
  const value = { sessions }
  if (selected !== undefined) value.selectedLeadSessionId = selected
  return value
}

/** Write one JSON response. `no-store` because every read reflects live state. */
function sendJson(res, status, value, headers) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...headers,
  })
  res.end(JSON.stringify(value))
}

/**
 * Read one JSON object body within the cap.
 * @param {object} request - node request.
 * @returns {Promise<Record<string, unknown>>} the parsed object, or `{}` for an empty body.
 */
async function readJsonBody(request) {
  const declared = Number(request.headers['content-length'])
  if (Number.isFinite(declared) && declared > BODY_LIMIT_BYTES) {
    throw new RequestError(`The request body exceeds ${String(BODY_LIMIT_BYTES)} bytes.`, 413)
  }
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > BODY_LIMIT_BYTES) {
      request.destroy?.()
      throw new RequestError(`The request body exceeds ${String(BODY_LIMIT_BYTES)} bytes.`, 413)
    }
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return {}
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new RequestError('The request body is not valid JSON.', 400)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new RequestError('The request body must be a JSON object.', 400)
  }
  return parsed
}

/**
 * Build the raw node request handler. Exported as a pure factory so the routing, the fence, and the
 * operations are testable without an HTTP socket.
 * @param {{ctx: object, store: Promise<object>, dataDir: string,
 *   hooks: {filter: {invalidate: Function}, slots: {refresh: Function}},
 *   log?: (line: string) => void}} dependencies
 * @returns {(req: object, res: object) => Promise<void>} the handler for `webServer.register`.
 */
export function createApiHandler({ ctx, store, dataDir, hooks, log = () => {} }) {
  return async function handleTeamRosterApi(request, response) {
    const rejection = rejectedRequest(request)
    if (rejection !== undefined) return sendJson(response, 403, { error: rejection })

    const url = new URL(request.url ?? '/', 'http://dsh.invalid')
    const route = resolveRoute(request.method ?? 'GET', url.pathname)
    if (route === undefined) return sendJson(response, 404, { error: 'This endpoint does not exist.' })
    if (route.methodNotAllowed === true) {
      return sendJson(response, 405, { error: 'This method is not accepted here.' }, { allow: route.allow.join(', ') })
    }

    let table
    try {
      table = await store
    } catch (error) {
      log(`team-roster: could not open the roster store (${error instanceof Error ? error.message : String(error)})`)
      return sendJson(response, 500, { error: 'The roster store could not be opened.' })
    }

    try {
      if (route.name === 'sessions') {
        const currentSessionId = (url.searchParams.get('currentSessionId') ?? '').trim()
        return sendJson(response, 200, buildSessionsIndex({ ctx, table, currentSessionId }))
      }
      if (route.name === 'state') {
        const leadSessionId = (url.searchParams.get('leadSessionId') ?? '').trim()
        if (leadSessionId === '') {
          return sendJson(response, 400, { error: 'leadSessionId is required.' })
        }
        return sendJson(response, 200, buildSessionState({ ctx, table, leadSessionId }))
      }

      const body = await readJsonBody(request)
      const leadSessionId = typeof body.leadSessionId === 'string' ? body.leadSessionId.trim() : ''
      const target = typeof body.target === 'string' ? body.target.trim() : ''
      if (leadSessionId === '' || target === '') {
        return sendJson(response, 400, { error: 'leadSessionId and target are required strings.' })
      }
      if (route.name === 'retire') {
        const result = await retireMember({
          ctx,
          table,
          leadSessionId,
          leadAgent: ctx.agents.get(leadSessionId),
          dataDir,
          hooks,
          target,
          reason: typeof body.reason === 'string' && body.reason.length > 0 ? body.reason : undefined,
        })
        return sendJson(response, 200, result)
      }
      const result = await restoreMember({ ctx, table, leadSessionId, target, hooks })
      return sendJson(response, 200, result)
    } catch (error) {
      if (error instanceof RequestError) {
        return sendJson(response, error.status, { error: error.message })
      }
      const message = error instanceof Error ? error.message : 'The operation failed.'
      log(`team-roster: ${message}`)
      return sendJson(response, 409, { error: message })
    }
  }
}

/**
 * Register the bridge on the Host web server.
 * @param {object} webCtx - the context that has `webServer`.
 * @param {Parameters<typeof createApiHandler>[0]} dependencies - store, operations' dependencies, logger.
 * @returns {Function} the disposer removing the route.
 */
export function registerTeamRosterRoutes(webCtx, dependencies) {
  return webCtx.effect(
    () => webCtx.webServer.register({
      kind: 'prefix',
      path: API_PREFIX,
      handler: createApiHandler(dependencies),
    }),
    'team-roster: settings bridge',
  )
}
