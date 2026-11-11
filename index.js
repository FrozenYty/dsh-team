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

import {
  PHASE,
  findByTarget,
  liveStateOf,
  openRosterStore,
  planMember,
  readRoster,
  targetOf,
  updateRoster,
  withMember,
  writeRoster,
} from './roster.js'

export const name = 'team-control'

export const inject = ['agents', 'agentTeams', 'tools', 'tokenMeter', 'storageDomain', 'subagents']

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

const MEMBER_ROW = {
  type: 'object',
  additionalProperties: false,
  required: ['target', 'phase', 'generation', 'label', 'status', 'resident'],
  properties: {
    target: { type: 'string' },
    phase: { type: 'string', enum: ['provisioning', 'active', 'retired', 'failed'] },
    generation: { type: 'integer' },
    label: { type: 'string' },
    status: { type: 'string', enum: ['running', 'idle', 'unloaded', 'unknown'] },
    resident: { type: 'boolean' },
    pressure_tokens: { type: 'integer' },
    context_window: { type: 'integer' },
    note: { type: 'string' },
  },
}

const MEMBER_LIST_VALUE = {
  type: 'object',
  additionalProperties: false,
  required: ['members'],
  properties: { members: { type: 'array', items: MEMBER_ROW } },
}

const RETIRE_VALUE = {
  type: 'object',
  additionalProperties: false,
  required: ['target', 'retired'],
  properties: {
    target: { type: 'string' },
    retired: { type: 'boolean' },
    drained: { type: 'boolean' },
    archived: { type: 'boolean' },
    message: { type: 'string' },
  },
}

/** The durable roster key for one Lead. */
function leadSessionIdOf(agent) {
  return String(agent.session.id)
}

/** Project one stored member into its model-facing row. */
function memberRow(ctx, member) {
  const live = liveStateOf(ctx, member)
  const row = {
    target: targetOf(member),
    phase: member.phase,
    generation: member.generation,
    label: member.label,
    status: live.status,
    resident: live.resident,
  }
  if (live.resident) {
    const agent = ctx.agents.get(member.childId)
    if (agent !== undefined) {
      const { pressureTokens, contextWindow } = ctx.tokenMeter.contextPressure(agent.session)
      row.pressure_tokens = pressureTokens
      row.context_window = contextWindow
    }
  }
  return row
}

/**
 * Install every Lead-scoped tool.
 * @param agent - exact Team Lead whose model should receive the tools.
 * @param ctx - plugin context.
 * @param store - promise of the roster table; resolved lazily by each roster tool.
 * @returns a disposer that unwinds every registration in reverse order.
 */
function install(agent, ctx, store) {
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

    register(scoped.tools.register(defineTool({
      name: 'spawn_member',
      description: 'Create one named team member. The member runs as a continuable subagent, reports back through a completion notice, and can be retired later. A successor reuses the same base name with the next generation suffix.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'label', 'prompt'],
        properties: {
          name: { type: 'string', description: 'Lowercase base name: 1-32 letters, digits or hyphens, starting with a letter.' },
          label: { type: 'string', description: 'Short responsibility text shown in the roster.' },
          prompt: { type: 'string', description: 'Complete initial task for the member.' },
        },
      },
      output: { schema: MEMBER_ROW },
      async execute(args, exec) {
        const caller = callingAgent(exec.agent, 'spawn_member')
        requireLead(ctx, caller, 'spawn_member')
        if (typeof args.name !== 'string' || typeof args.label !== 'string' || typeof args.prompt !== 'string') {
          throw new Error('spawn_member: name, label and prompt must be strings')
        }
        const table = await store
        const leadSessionId = leadSessionIdOf(caller)
        const planned = planMember(readRoster(table, leadSessionId), args.name, args.label)
        // Persist the reservation before starting anything: a crash must leave a visible member,
        // never an invisible child.
        await writeRoster(table, leadSessionId, withMember(readRoster(table, leadSessionId), planned))
        let started
        try {
          started = await ctx.subagents.startActivation({
            delivery: 'parent',
            childId: planned.childId,
            provider: 'spawn',
            label: args.label,
            request: { prompt: [{ type: 'text', text: args.prompt }], parent: caller },
            signal: exec.signal,
          })
        } catch (error) {
          const failed = {
            ...planned,
            phase: PHASE.failed,
            note: error instanceof Error ? error.message : String(error),
          }
          await updateRoster(table, leadSessionId, (roster) => withMember(roster, failed))
          throw error
        }
        const active = { ...planned, childId: started.childId ?? planned.childId, phase: PHASE.active }
        await updateRoster(table, leadSessionId, (roster) => withMember(roster, active))
        return memberRow(ctx, active)
      },
    })))

    register(scoped.tools.register(defineTool({
      name: 'list_members',
      description: 'List every member of this roster with its lifecycle phase and live state. Retired members stay listed with phase retired. Use this instead of list_agents for members created by spawn_member.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {},
      },
      output: { schema: MEMBER_LIST_VALUE },
      async execute(_args, exec) {
        const caller = callingAgent(exec.agent, 'list_members')
        requireLead(ctx, caller, 'list_members')
        const table = await store
        const roster = readRoster(table, leadSessionIdOf(caller))
        return { members: roster.members.map((member) => memberRow(ctx, member)) }
      },
    })))

    register(scoped.tools.register(defineTool({
      name: 'retire_member',
      description: 'Retire one member: stop it, release its capacity slot, hide it from the workspace, and tombstone its record. This is the removal operation the shipped team roster does not have. A successor can then reuse the base name at the next generation.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['target'],
        properties: {
          target: { type: 'string', description: 'Member target from list_members, such as reviewer or reviewer-g2.' },
          reason: { type: 'string', description: 'Optional short reason, stored on the record.' },
        },
      },
      output: { schema: RETIRE_VALUE },
      async execute(args, exec) {
        const caller = callingAgent(exec.agent, 'retire_member')
        requireLead(ctx, caller, 'retire_member')
        if (typeof args.target !== 'string' || args.target.length === 0) {
          throw new Error('retire_member: target must be a non-empty string')
        }
        const table = await store
        const leadSessionId = leadSessionIdOf(caller)
        const member = findByTarget(readRoster(table, leadSessionId), args.target)
        if (member === undefined) throw new Error(`retire_member: no live member named "${args.target}"`)

        let drained = false
        try {
          await ctx.subagents.drainChildren(caller, [member.childId])
          drained = true
        } catch (error) {
          // A child that never published, or already settled, has nothing to drain. Retirement is a
          // lifecycle fact owned by the record, so it proceeds.
        }

        let archived = false
        const workspace = ctx.get('workspaceRegistry')
        if (workspace !== undefined) {
          try {
            await workspace.archiveSession(member.childId, { stopActivity: true })
            archived = true
          } catch (error) {
            // Archiving is presentation only; it must never block retirement.
          }
        }

        const retired = { ...member, phase: PHASE.retired, retiredAt: new Date().toISOString() }
        if (typeof args.reason === 'string' && args.reason.length > 0) retired.retireReason = args.reason
        await updateRoster(table, leadSessionId, (roster) => withMember(roster, retired))
        return {
          target: targetOf(member),
          retired: true,
          drained,
          archived,
          message: 'Member retired: drained, tombstoned, and archived when the workspace service is available.',
        }
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
  // The storage facility is the readiness barrier for the roster; a rejected open surfaces as a tool
  // error on first use instead of an unhandled rejection at load.
  const store = openRosterStore(ctx)
  store.catch(() => undefined)

  const maybeInstall = (agent) => {
    if (installed.has(agent)) return
    const membership = ctx.agentTeams.tryMembership(agent)
    if (membership === undefined || membership.role !== 'lead') return
    installed.set(agent, install(agent, ctx, store))
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
