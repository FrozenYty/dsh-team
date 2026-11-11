/**
 * Team Control — inspect and reclaim context for Agent Teams members.
 *
 * v0.1 (Host half). Adds two Team-Lead-only tools beside the official
 * experimental Agent Teams tool set:
 *
 *   - `member_context`  reports every member's context pressure.
 *   - `compact_member`  force-compacts one idle member in place.
 *
 * WHY THIS FILE IMPORTS NOTHING
 * A profile-installed bundle is linked from its workspace directory, so a bare
 * import such as `@deepseek-ai/dsh-tools` resolves from the bundle path and
 * fails with ERR_MODULE_NOT_FOUND. Shipped packages resolve only from inside the
 * dsh installation, and the installed first-party market plugin likewise imports
 * no dsh package. Tool definitions are therefore built as plain canonical JSON
 * Schema objects, which is exactly the `ToolDefinition` shape the registry
 * consumes (`ctx.tools.register` checks `output.schema` + `output.render` and
 * projects `parameters` straight to the model).
 *
 * The plugin writes no session events and changes no roster semantics. It is
 * inert in profiles without Agent Teams, and it never shadows an official tool
 * name: it only adds the two below.
 */

export const name = 'team-control'

export const inject = ['agents', 'agentTeams', 'tools', 'tokenMeter']

/** Usage ratio at or above which `member_context` flags a member as under pressure. */
const WARN_USAGE_RATIO = 0.75

/** Build a registry-ready definition from canonical JSON Schemas. */
function defineTool(options) {
  return {
    name: options.name,
    description: options.description,
    parameters: options.parameters,
    output: {
      schema: options.output.schema,
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute: options.execute,
  }
}

/** Recover the exact caller that Agent-scoped tool discovery supplies. */
function callingAgent(agent, toolName) {
  if (agent === undefined) throw new Error(`${toolName} requires a calling Agent`)
  return agent
}

/** Refuse every caller that is not the Lead of its own Team. */
function requireLead(ctx, caller, toolName) {
  const membership = ctx.agentTeams.tryMembership(caller)
  if (membership === undefined || membership.role !== 'lead') {
    throw new Error(`${toolName} is available to the Team Lead only`)
  }
}

/** Resolve one roster row by member name, then by raw session id. */
function findMember(ctx, caller, target) {
  const members = ctx.agentTeams.listMembers(caller)
  return members.find((member) => member.name === target)
    ?? members.find((member) => member.id === target)
    ?? undefined
}

/** Read live context pressure for one resident member. */
function pressureOf(ctx, agent) {
  const { pressureTokens, contextWindow } = ctx.tokenMeter.contextPressure(agent.session)
  const ratio = contextWindow > 0 ? pressureTokens / contextWindow : undefined
  return { pressureTokens, contextWindow, ratio }
}

const MEMBER_CONTEXT_ROW = {
  type: 'object',
  additionalProperties: false,
  required: ['target', 'role', 'status', 'resident', 'under_pressure', 'compactable'],
  properties: {
    target: { type: 'string' },
    role: { type: 'string', enum: ['lead', 'teammate'] },
    status: { type: 'string', enum: ['running', 'inactive', 'provisioning', 'failed', 'unknown'] },
    resident: { type: 'boolean' },
    pressure_tokens: { type: 'integer' },
    context_window: { type: 'integer' },
    usage_ratio: { type: 'number' },
    under_pressure: { type: 'boolean' },
    compactable: { type: 'boolean' },
    note: { type: 'string' },
  },
}

const MEMBER_CONTEXT_VALUE = {
  type: 'object',
  additionalProperties: false,
  required: ['members', 'compactor'],
  properties: {
    members: { type: 'array', items: MEMBER_CONTEXT_ROW },
    compactor: { type: 'string', enum: ['available', 'unavailable'] },
  },
}

const COMPACT_VALUE = {
  type: 'object',
  additionalProperties: false,
  required: ['target', 'compacted'],
  properties: {
    target: { type: 'string' },
    compacted: { type: 'boolean' },
    reason: { type: 'string', enum: ['done', 'nothing-to-compact', 'busy', 'not-resident', 'failed'] },
    shadowed_tokens: { type: 'integer' },
    before_tokens: { type: 'integer' },
    after_tokens: { type: 'integer' },
    message: { type: 'string' },
  },
}

/**
 * Install both tools into one Lead Agent scope.
 * @param agent - exact Team Lead whose model should receive the tools.
 * @param ctx - plugin context.
 * @returns a disposer that unwinds every registration in reverse order.
 */
function install(agent, ctx) {
  const scoped = agent.ctx
  const disposers = []
  const register = (disposer) => {
    disposers.push(disposer)
  }

  try {
    register(scoped.tools.register(defineTool({
      name: 'member_context',
      description: 'Report every Agent Teams member\'s live context pressure, in tokens and as a window ratio. Read it before deciding whether a member needs compacting. The Lead row is included.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {},
      },
      output: { schema: MEMBER_CONTEXT_VALUE },
      execute(_args, exec) {
        const caller = callingAgent(exec.agent, 'member_context')
        requireLead(ctx, caller, 'member_context')
        const compaction = ctx.get('compaction')
        const members = ctx.agentTeams.listMembers(caller).map((member) => {
          const row = {
            target: member.name,
            role: member.role,
            status: member.status ?? 'unknown',
            resident: false,
            under_pressure: false,
            compactable: false,
          }
          const live = ctx.agents.get(member.id)
          if (live === undefined) {
            row.note = 'Not resident: an idle child is unloaded. Send it a message to wake it; automatic compaction then reduces its pressure before the next model step.'
            return row
          }
          row.resident = true
          const { pressureTokens, contextWindow, ratio } = pressureOf(ctx, live)
          row.pressure_tokens = pressureTokens
          row.context_window = contextWindow
          if (ratio !== undefined) row.usage_ratio = ratio
          row.under_pressure = ratio !== undefined && ratio >= WARN_USAGE_RATIO
          row.compactable = compaction !== undefined && live.status !== 'running'
          if (live.status === 'running') {
            row.note = 'A running member cannot be compacted; interrupt it or wait for its turn to end.'
          }
          return row
        })
        return { members, compactor: compaction === undefined ? 'unavailable' : 'available' }
      },
    })))

    register(scoped.tools.register(defineTool({
      name: 'compact_member',
      description: 'Force one context compaction on an in-place resident, idle Agent Teams member, keeping its identity and session. It costs one summarization model call and does nothing when no safe older range can be condensed. An idle child is normally unloaded, so this usually applies only while the member is still resident; to reduce a finished member\'s pressure, wake it with send_message and let its automatic compaction run.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['target'],
        properties: {
          target: {
            type: 'string',
            description: 'Member target: the name from list_agents, or the session id.',
          },
        },
      },
      output: { schema: COMPACT_VALUE },
      async execute(args, exec) {
        const caller = callingAgent(exec.agent, 'compact_member')
        requireLead(ctx, caller, 'compact_member')
        if (typeof args.target !== 'string' || args.target.length === 0) {
          throw new Error('compact_member: target must be a non-empty string')
        }
        const member = findMember(ctx, caller, args.target)
        if (member === undefined) throw new Error(`compact_member: no Team member named "${args.target}"`)

        const compaction = ctx.get('compaction')
        if (compaction === undefined) throw new Error('compact_member: no compaction backend is mounted in this profile')

        const live = ctx.agents.get(member.id)
        if (live === undefined) {
          return {
            target: member.name,
            compacted: false,
            reason: 'not-resident',
            message: 'This member is not resident: an idle child is unloaded, and a resumed member compacts itself automatically at its next step. Send it a message to wake it if its pressure needs reducing.',
          }
        }
        if (live.status === 'running') {
          return {
            target: member.name,
            compacted: false,
            reason: 'busy',
            message: 'The member is running a turn. Wait for it to go idle, or interrupt it, then retry.',
          }
        }

        const before = pressureOf(ctx, live).pressureTokens
        let result
        try {
          result = await compaction.compactNow(live, exec.signal)
        } catch (error) {
          return {
            target: member.name,
            compacted: false,
            reason: 'failed',
            before_tokens: before,
            message: error instanceof Error ? error.message : String(error),
          }
        }
        if (result === null || result === undefined) {
          return {
            target: member.name,
            compacted: false,
            reason: 'nothing-to-compact',
            before_tokens: before,
            after_tokens: pressureOf(ctx, live).pressureTokens,
            message: 'No safely compactable range was found; the older history is likely one indivisible unit.',
          }
        }
        const value = {
          target: member.name,
          compacted: true,
          reason: 'done',
          before_tokens: before,
          after_tokens: pressureOf(ctx, live).pressureTokens,
          message: 'The member was compacted in place; its identity and session are unchanged.',
        }
        if (typeof result.shadowedTokenCount === 'number') value.shadowed_tokens = result.shadowedTokenCount
        return value
      },
    })))
  } catch (error) {
    for (const dispose of disposers.reverse()) dispose()
    throw error
  }

  return () => {
    for (const dispose of disposers.reverse()) dispose()
  }
}

/**
 * Install the tools in every live and subsequently published Lead scope.
 * @param ctx - plugin context.
 */
export function apply(ctx) {
  const installed = new Map()

  const maybeInstall = (agent) => {
    if (installed.has(agent)) return
    const membership = ctx.agentTeams.tryMembership(agent)
    if (membership === undefined || membership.role !== 'lead') return
    installed.set(agent, install(agent, ctx))
  }

  for (const agent of ctx.agents.list()) maybeInstall(agent)
  ctx.on('agent/created', ({ agent }) => {
    maybeInstall(agent)
  })
  ctx.on('agent/disposed', ({ agent }) => {
    installed.get(agent)?.()
    installed.delete(agent)
  })
  ctx.effect(() => () => {
    for (const dispose of installed.values()) dispose()
    installed.clear()
  }, 'team-control.scopedTools()')
}
