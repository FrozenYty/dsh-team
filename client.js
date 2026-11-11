/**
 * Team roster — the Settings panel, browser half.
 *
 * The bundle declares `dsh.client` (`platform: web`) and the host composes this file into the page under
 * `/plugins`; the registration id must equal the package name. `settings.section` is a list slot owned by
 * the settings shell, so this panel is one page beside General, Models and Plugins.
 *
 * The panel is **per session**: it shows one Lead Session's roster, defaults to the session the user is
 * in, and offers a picker for the other sessions that have one. The Host serves one roster
 * (`GET /api/team-roster/state?leadSessionId=`) plus a counts-only index (`GET /api/team-roster/sessions`);
 * it never lists Sessions, and the join against session titles happens here.
 *
 * HOW THE CURRENT SESSION IS RESOLVED (verified against the installed Harness, not assumed)
 * `settings.section` is root-scoped, and the root scope provides the shell's standard hooks — the session
 * catalog among them: `@deepseek-ai/dsh-client-ui-session/lib/client.js` lines 1120-1123 call
 * `ctx.slots.provideRoot({ hooks: { sessions: ctx.sessions.list }, ... })`, which is the `useSessions`
 * seat. The row shape comes from `@deepseek-ai/dsh-api-session-controller/lib/client.js` lines 4162-4182
 * (`projectList`): `{ id, displayTitle, title?, running, retainedBy, blank, updatedAt, ... }`. The
 * shell's own "currently open session" test is `(row.retainedBy.mainView ?? 0) > 0` — copied from
 * `@deepseek-ai/dsh-client-ui-workspace/lib/client.js` line 3697 (the root-scoped `sidebar.workspaces`
 * browser, which reads `useSessions((state) => state)` on line 3669). If that seat is absent, the panel
 * falls back to the Host's documented rule: the index is ordered live-Lead-first, so
 * `selectedLeadSessionId` names a roster whose Lead is live, and the picker is the visible way out.
 *
 * React (and only React) comes from the browser module table, so there is no build step. Visible text is
 * registered as a Client locale namespace: the slot receives `locale: 'team-roster'` and the framework
 * injects the `t` seat. The bundle's `locale/*.json` is Host-side plugin-catalog metadata, not a Client
 * dictionary source; the browser artifact cannot read files from the bundle directory.
 */

window.__ModuleLoader__.load({
  id: 'dsh-team-roster',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** The bridge prefix registered by the Host half. */
    const API_BASE = '/api/team-roster'
    /** Client locale namespace owned by this panel. */
    const NS = 'team-roster'
    /** How often the panel re-reads the roster while it is open. */
    const POLL_MS = 3000
    /** Slot order: after General (0), Models (10) and before shell-only sections. */
    const SECTION_ORDER = 25
    /** Stable selector for the root session-catalog hook; identity keeps `useSessions` from re-reading. */
    const ALL_SESSIONS = (state) => state

    /** Both built-in locales, because the locale service requires a complete pair. */
    const DICTIONARIES = {
      en: {
        nav: 'Team roster',
        title: 'Team roster',
        subtitle: 'One roster per Lead session. This page shows the session you are in, or the one you pick; retiring drains a member and moves its session to the trash, restoring moves it back.',
        refresh: 'Refresh',
        loading: 'Loading the roster…',
        empty: 'No team roster for this session yet.',
        emptyProfile: 'No team roster has been recorded in this profile yet.',
        session: 'Session',
        picker: 'Session',
        pickerHint: 'Sessions that have a roster.',
        current: 'you are here',
        noRosterOption: 'no roster yet',
        leadLive: 'live',
        leadOffline: 'not live',
        leadOfflineHint: 'This Lead session is not open, so its members cannot be retired right now. Restoring a retired member still works.',
        members: 'members',
        noMembers: 'No members recorded for this session.',
        generation: 'gen',
        context: 'Context pressure',
        resident: 'resident',
        notResident: 'not resident',
        phaseProvisioning: 'provisioning',
        phaseActive: 'active',
        phaseFailed: 'failed',
        phaseRetired: 'retired',
        statusRunning: 'running',
        statusIdle: 'idle',
        statusUnloaded: 'unloaded',
        retire: 'Retire',
        restore: 'Restore',
        confirmRetire: 'Retire "{}"? This drains the member, moves its session to the trash, and hides it from every client.',
        confirmRestore: 'Restore "{}"? Its session moves back to where it came from.',
        confirm: 'Confirm',
        cancel: 'Cancel',
        actionFailed: 'The operation failed.',
        requestFailed: 'The request failed',
      },
      zh: {
        nav: '团队花名册',
        title: '团队花名册',
        subtitle: '每个 Lead 会话各自一份花名册。本页显示你当前所在的会话，或你选中的会话；退役会排空成员并把会话移入回收站，恢复会把它移回去。',
        refresh: '刷新',
        loading: '正在读取花名册…',
        empty: '这个会话还没有团队花名册。',
        emptyProfile: '本 profile 还没有任何团队花名册。',
        session: '会话',
        picker: '会话',
        pickerHint: '拥有花名册的会话。',
        current: '当前所在',
        noRosterOption: '尚无花名册',
        leadLive: '在线',
        leadOffline: '未在线',
        leadOfflineHint: '该 Lead 会话未打开，成员暂时无法退役；恢复已退役成员仍然可用。',
        members: '名成员',
        noMembers: '该会话暂无成员。',
        generation: '代次',
        context: '上下文压力',
        resident: '驻留',
        notResident: '未驻留',
        phaseProvisioning: '创建中',
        phaseActive: '活跃',
        phaseFailed: '失败',
        phaseRetired: '已退役',
        statusRunning: '运行中',
        statusIdle: '空闲',
        statusUnloaded: '已卸载',
        retire: '退役',
        restore: '恢复',
        confirmRetire: '退役 “{}”？这会排空该成员、把会话移入回收站，并让所有客户端不再显示它。',
        confirmRestore: '恢复 “{}”？它的会话会被移回原路径。',
        confirm: '确认',
        cancel: '取消',
        actionFailed: '操作失败。',
        requestFailed: '请求失败',
      },
    }

    /** Phase key to dictionary key. */
    const PHASE_TEXT = {
      provisioning: 'phaseProvisioning',
      active: 'phaseActive',
      failed: 'phaseFailed',
      retired: 'phaseRetired',
    }
    /** Member status key to dictionary key. */
    const STATUS_TEXT = {
      running: 'statusRunning',
      idle: 'statusIdle',
      unloaded: 'statusUnloaded',
    }

    /** Locale fallback when the slot does not deliver a `t` seat. */
    const PREFERRED_LANGUAGE = typeof navigator === 'object' && navigator !== null && typeof navigator.language === 'string'
      ? navigator.language.toLowerCase()
      : 'en'
    const FALLBACK_TEXT = PREFERRED_LANGUAGE.startsWith('zh') ? DICTIONARIES.zh : DICTIONARIES.en
    const fallbackTranslate = (key) => FALLBACK_TEXT[key] ?? DICTIONARIES.en[key] ?? key

    /** The panel stylesheet: theme tokens only for colours, rendered by the component so unmounting drops it. */
    const CSS = [
      '.tr-panel{display:flex;flex-direction:column;gap:14px;max-width:760px;min-width:0;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px}',
      '.tr-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}',
      '.tr-title{margin:0;font-size:15px;font-weight:600;line-height:22px}',
      '.tr-sub{margin:4px 0 0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}',
      '.tr-actions{display:flex;align-items:center;gap:6px;flex-shrink:0}',
      '.tr-note{margin:0;padding:8px 10px;border:1px solid var(--dsw-alias-state-error-primary);border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px}',
      '.tr-empty{margin:0;padding:10px 14px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}',
      '.tr-group{overflow:hidden;border:1px solid var(--dsw-alias-border-l2);border-radius:14px;background:var(--dsw-alias-bg-layer-2)}',
      '.tr-group-head{display:flex;align-items:center;flex-wrap:wrap;gap:8px;padding:10px 14px;border-bottom:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3)}',
      '.tr-lead{color:var(--dsw-alias-label-tertiary);font-size:12px}',
      '.tr-lead-id{color:var(--dsw-alias-label-secondary);font-family:var(--dsw-font-markdown-code-font-family,ui-monospace,monospace);font-size:12px}',
      '.tr-badge{padding:1px 7px;border:.5px solid var(--dsw-alias-border-l3);border-radius:999px;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px}',
      '.tr-badge--live{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary)}',
      '.tr-head-right{margin-left:auto;display:flex;align-items:center;gap:8px}',
      '.tr-count{color:var(--dsw-alias-label-tertiary);font-size:11px;font-variant-numeric:tabular-nums}',
      '.tr-hint{padding:8px 14px;border-bottom:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}',
      '.tr-rows{margin:0;padding:0;list-style:none}',
      '.tr-item+.tr-item{border-top:1px solid var(--dsw-alias-border-l1)}',
      '.tr-row{display:flex;align-items:center;gap:10px;padding:9px 14px}',
      '.tr-main{display:flex;flex-direction:column;flex:1;min-width:0}',
      '.tr-target{overflow:hidden;color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-markdown-code-font-family,ui-monospace,monospace);font-size:13px;font-weight:600;text-overflow:ellipsis;white-space:nowrap}',
      '.tr-label{overflow:hidden;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;text-overflow:ellipsis;white-space:nowrap}',
      '.tr-phase{padding:1px 7px;border:.5px solid currentColor;border-radius:999px;font-size:11px;line-height:16px;white-space:nowrap}',
      '.tr-phase--active{color:var(--dsw-alias-state-success-primary)}',
      '.tr-phase--provisioning{color:var(--dsw-alias-state-warn-primary)}',
      '.tr-phase--failed{color:var(--dsw-alias-state-error-primary)}',
      '.tr-phase--retired{color:var(--dsw-alias-label-tertiary)}',
      '.tr-meta{display:inline-flex;align-items:center;gap:5px;flex-shrink:0;color:var(--dsw-alias-label-tertiary);font-size:11px;white-space:nowrap}',
      '.tr-status--running{color:var(--dsw-alias-state-success-primary)}',
      '.tr-status--idle{color:var(--dsw-alias-state-business-primary)}',
      '.tr-status--unloaded{color:var(--dsw-alias-label-tertiary)}',
      '.tr-dot{width:6px;height:6px;border-radius:50%;background:currentColor}',
      '.tr-pressure{font-variant-numeric:tabular-nums}',
      '.tr-picker{display:flex;align-items:center;gap:8px;padding:10px 14px;border:1px solid var(--dsw-alias-border-l2);border-radius:14px;background:var(--dsw-alias-bg-layer-2)}',
      '.tr-picker-label{color:var(--dsw-alias-label-tertiary);font-size:12px;white-space:nowrap}',
      '.tr-select{flex:1;min-width:0;padding:4px 8px;border:.5px solid var(--dsw-alias-border-l3);border-radius:6px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:18px}',
      '.tr-here{padding:1px 7px;border:.5px solid var(--dsw-alias-state-business-primary);border-radius:999px;color:var(--dsw-alias-state-business-primary);font-size:11px;line-height:16px;white-space:nowrap}',
      '.tr-btn{padding:3px 10px;border:.5px solid var(--dsw-alias-border-l3);border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:18px;cursor:pointer;white-space:nowrap}',
      '.tr-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
      '.tr-btn:disabled{color:var(--dsw-alias-label-dimmed);cursor:default}',
      '.tr-btn--danger{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}',
      '.tr-btn--danger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger)}',
      '.tr-btn--primary{border-color:transparent;background:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-label-primary-foreground)}',
      '.tr-confirm{display:flex;align-items:center;flex-wrap:wrap;gap:10px;padding:9px 14px;border-top:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}',
      '.tr-confirm-text{flex:1;min-width:0}',
    ].join('')

    /** One human-readable sentence from one already-localized template. */
    function fill(template, value) {
      return template.replace('{}', value)
    }

    /** Turn any thrown value into display text. */
    function messageOf(error) {
      return error instanceof Error ? error.message : String(error)
    }

    /** A Session id short enough for a header, with the full value kept in `title`. */
    function shortId(id) {
      return id.length <= 12 ? id : `${id.slice(0, 8)}…`
    }

    /** Compact token counts: 1234 → 1.2k, 1048576 → 1.0M. */
    function formatTokens(tokens) {
      if (tokens >= 1000000) return `${(tokens / 1000000).toFixed(1)}M`
      if (tokens >= 1000) return `${Math.round(tokens / 1000)}k`
      return String(tokens)
    }

    /**
     * The id of the session the shell currently has open, or undefined.
     * Copied from the shipped root-scoped session browser:
     * `@deepseek-ai/dsh-client-ui-workspace/lib/client.js` line 3697.
     * @param {{byId?: Record<string, {retainedBy?: {mainView?: number}}>}} sessions - `useSessions` snapshot.
     * @returns {string|undefined} the retained main-view session id.
     */
    function currentSessionIdOf(sessions) {
      const byId = sessions?.byId
      if (byId === null || typeof byId !== 'object') return undefined
      return Object.values(byId).find((row) => (row?.retainedBy?.mainView ?? 0) > 0)?.id
    }

    /**
     * A session's display title from the catalog the shell already holds, when it has one.
     * `displayTitle` and `title` are projected by the session controller
     * (`@deepseek-ai/dsh-api-session-controller/lib/client.js` lines 4171 and 4178).
     * @param {object|undefined} sessions - `useSessions` snapshot.
     * @param {string} id - Session id.
     * @returns {string|undefined} the title, or undefined when the catalog does not know one.
     */
    function titleOf(sessions, id) {
      const row = sessions?.byId?.[id]
      const value = typeof row?.displayTitle === 'string' && row.displayTitle !== '' ? row.displayTitle : row?.title
      return typeof value === 'string' && value !== '' ? value : undefined
    }

    /**
     * Which roster the panel opens: the user's explicit pick while it still exists, else the session the
     * user is in, else the Host's documented fallback selection.
     * @param {{index?: {sessions: object[], selected?: string}, picked?: string, current?: string}} input
     * @returns {string|undefined} the Lead Session id to render.
     */
    function resolveTarget({ index, picked, current }) {
      const known = index?.sessions ?? []
      if (picked !== undefined && (picked === current || known.some((row) => row.leadSessionId === picked))) return picked
      if (current !== undefined) return current
      return index?.selected
    }

    /** Read one JSON response, turning a non-2xx answer into an Error carrying the server's reason. */
    async function readJson(response, t) {
      const body = await response.json().catch(() => ({}))
      if (!response.ok) {
        throw new Error(typeof body.error === 'string' ? body.error : `${t('requestFailed')} (${String(response.status)})`)
      }
      return body
    }

    /**
     * The settings page: one Lead Session's roster, chosen by the session the user is in and switchable
     * through a picker over the sessions that have one.
     * @param props - slot owner props `{ close }` plus the framework seats (`t`, `renderSlot`, root hooks).
     * @returns the panel element tree.
     */
    function TeamRosterPanel(props) {
      const t = typeof props?.t === 'function' ? props.t : fallbackTranslate
      const tRef = React.useRef(t)
      tRef.current = t

      // Root-scoped standard hook. The seat is fixed for the life of the page, so calling it
      // conditionally keeps the hook order stable while still tolerating a shell that lacks it.
      const sessionHook = props?.useSessions
      const sessions = typeof sessionHook === 'function' ? sessionHook(ALL_SESSIONS) : undefined
      const currentSessionId = currentSessionIdOf(sessions)

      const [status, setStatus] = React.useState('loading')
      const [index, setIndex] = React.useState(undefined)
      const [picked, setPicked] = React.useState(undefined)
      const [roster, setRoster] = React.useState(undefined)
      const [readError, setReadError] = React.useState(undefined)
      const [actionError, setActionError] = React.useState(undefined)
      const [confirming, setConfirming] = React.useState(undefined)
      const [busy, setBusy] = React.useState(undefined)
      const alive = React.useRef(true)

      const target = resolveTarget({ index, picked, current: currentSessionId })
      const targetRef = React.useRef(target)
      targetRef.current = target
      const currentRef = React.useRef(currentSessionId)
      currentRef.current = currentSessionId

      const readSessionState = React.useCallback(async (leadSessionId) => {
        const body = await readJson(
          await fetch(`${API_BASE}/state?leadSessionId=${encodeURIComponent(leadSessionId)}`, {
            headers: { accept: 'application/json' },
          }),
          tRef.current,
        )
        // A slow answer for a session the user has already left must not replace the current one.
        if (!alive.current || targetRef.current !== leadSessionId) return
        setRoster(body)
        setReadError(undefined)
        setStatus('ready')
      }, [])

      const readIndex = React.useCallback(async () => {
        const current = currentRef.current
        const query = current === undefined ? '' : `?currentSessionId=${encodeURIComponent(current)}`
        const body = await readJson(
          await fetch(`${API_BASE}/sessions${query}`, { headers: { accept: 'application/json' } }),
          tRef.current,
        )
        if (!alive.current) return
        setIndex({
          sessions: Array.isArray(body.sessions) ? body.sessions : [],
          selected: typeof body.selectedLeadSessionId === 'string' ? body.selectedLeadSessionId : undefined,
        })
      }, [])

      const refresh = React.useCallback(async () => {
        try {
          await readIndex()
          const open = targetRef.current
          if (open === undefined) {
            if (alive.current) {
              setRoster(undefined)
              setReadError(undefined)
              setStatus('ready')
            }
            return
          }
          await readSessionState(open)
        } catch (error) {
          if (!alive.current) return
          setReadError(messageOf(error))
          setStatus('ready')
        }
      }, [readIndex, readSessionState])

      React.useEffect(() => {
        alive.current = true
        void refresh()
        const timer = setInterval(() => {
          void refresh()
        }, POLL_MS)
        return () => {
          alive.current = false
          clearInterval(timer)
        }
      }, [refresh, currentSessionId])

      // A pick must read immediately rather than at the next poll.
      React.useEffect(() => {
        if (target === undefined) return
        void readSessionState(target).catch((error) => {
          if (alive.current) setReadError(messageOf(error))
        })
      }, [target, readSessionState])

      const run = async (kind, leadSessionId, memberTarget) => {
        setBusy(memberTarget)
        setActionError(undefined)
        try {
          const body = await readJson(await fetch(`${API_BASE}/${kind}`, {
            method: 'POST',
            headers: { accept: 'application/json', 'content-type': 'application/json' },
            body: JSON.stringify({ leadSessionId, target: memberTarget }),
          }), tRef.current)
          const refused = kind === 'retire' ? body.retired === false : body.restored === false
          if (refused) {
            setActionError(typeof body.message === 'string' ? body.message : tRef.current('actionFailed'))
          }
          setConfirming(undefined)
          await refresh()
        } catch (error) {
          setActionError(messageOf(error))
        } finally {
          setBusy(undefined)
        }
      }

      const startConfirm = (leadSessionId, memberTarget, kind) => {
        setActionError(undefined)
        setConfirming({ leadSessionId, target: memberTarget, kind })
      }

      const memberRow = (leadSessionId, member) => {
        const retired = member.phase === 'retired'
        const pending = confirming !== undefined && confirming.leadSessionId === leadSessionId && confirming.target === member.target
        const statusText = STATUS_TEXT[member.status] ?? 'statusUnloaded'
        const pressure = member.resident && typeof member.pressure_tokens === 'number' && typeof member.context_window === 'number'
          ? `${formatTokens(member.pressure_tokens)} / ${formatTokens(member.context_window)}${typeof member.usage_ratio === 'number' ? ` · ${String(Math.round(member.usage_ratio * 100))}%` : ''}`
          : undefined
        return h('li', { className: 'tr-item', key: member.target },
          h('div', { className: 'tr-row' },
            h('div', { className: 'tr-main' },
              h('span', { className: 'tr-target', title: member.target }, member.target),
              member.label === undefined ? null : h('span', { className: 'tr-label', title: member.label }, member.label)),
            h('span', { className: `tr-phase tr-phase--${member.phase}` }, t(PHASE_TEXT[member.phase] ?? member.phase)),
            h('span', { className: 'tr-meta', title: t('generation') }, `${t('generation')} ${String(member.generation)}`),
            retired ? null : h('span', {
              className: `tr-meta tr-status tr-status--${member.status}`,
              title: member.resident ? t('resident') : t('notResident'),
            }, h('span', { className: 'tr-dot' }), t(statusText)),
            pressure === undefined ? null : h('span', { className: 'tr-meta tr-pressure', title: t('context') }, pressure),
            h('div', { className: 'tr-actions' },
              retired
                ? h('button', {
                  type: 'button',
                  className: 'tr-btn',
                  disabled: busy !== undefined,
                  onClick: () => startConfirm(leadSessionId, member.target, 'restore'),
                }, t('restore'))
                : h('button', {
                  type: 'button',
                  className: 'tr-btn tr-btn--danger',
                  disabled: busy !== undefined,
                  onClick: () => startConfirm(leadSessionId, member.target, 'retire'),
                }, t('retire')))),
          pending
            ? h('div', { className: 'tr-confirm' },
              h('span', { className: 'tr-confirm-text' }, fill(
                t(pending.kind === 'retire' ? 'confirmRetire' : 'confirmRestore'),
                member.target,
              )),
              h('button', { type: 'button', className: 'tr-btn', disabled: busy !== undefined, onClick: () => setConfirming(undefined) }, t('cancel')),
              h('button', {
                type: 'button',
                className: 'tr-btn tr-btn--primary',
                disabled: busy !== undefined,
                onClick: () => void run(pending.kind, leadSessionId, member.target),
              }, busy === member.target ? '…' : t('confirm')))
            : null)
      }

      const known = index?.sessions ?? []
      const open = roster !== undefined && target !== undefined && roster.leadSessionId === target ? roster : undefined

      /** One label for the picker: the shell's title when it has one, else the short id. */
      const labelOf = (id) => {
        const title = titleOf(sessions, id)
        return title === undefined ? shortId(id) : title
      }

      const options = known.map((row) => ({
        value: row.leadSessionId,
        label: `${labelOf(row.leadSessionId)} · ${String(row.memberCount)} ${t('members')}${row.leadLive ? '' : ` · ${t('leadOffline')}`}${row.leadSessionId === currentSessionId ? ` · ${t('current')}` : ''}`,
      }))
      if (target !== undefined && !known.some((row) => row.leadSessionId === target)) {
        options.unshift({
          value: target,
          label: `${labelOf(target)} · ${t('noRosterOption')}${target === currentSessionId ? ` · ${t('current')}` : ''}`,
        })
      }

      const picker = h('div', { className: 'tr-picker' },
        h('label', { className: 'tr-picker-label', htmlFor: 'tr-session-select' }, t('picker')),
        h('select', {
          id: 'tr-session-select',
          className: 'tr-select',
          value: target ?? '',
          disabled: options.length === 0,
          title: t('pickerHint'),
          onChange: (event) => setPicked(event.target.value),
        }, options.map((option) => h('option', { key: option.value, value: option.value }, option.label))),
        target !== undefined && target === currentSessionId
          ? h('span', { className: 'tr-here' }, t('current'))
          : null)

      const header = h('section', { className: 'tr-group' },
        h('div', { className: 'tr-group-head' },
          h('span', { className: 'tr-lead' }, t('session')),
          h('code', { className: 'tr-lead-id', title: target ?? '' }, target === undefined ? '—' : shortId(target)),
          target === undefined ? null : h('span', { title: labelOf(target) }, labelOf(target)),
          h('span', { className: `tr-badge${open?.leadLive ? ' tr-badge--live' : ''}` }, open?.leadLive ? t('leadLive') : t('leadOffline')),
          h('span', { className: 'tr-head-right' },
            h('span', { className: 'tr-count' }, `${String(open?.members?.length ?? 0)} ${t('members')}`))),
        open?.leadLive === false ? h('div', { className: 'tr-hint' }, t('leadOfflineHint')) : null,
        open === undefined || open.exists === false
          ? null
          : open.members.length === 0
            ? h('div', { className: 'tr-empty' }, t('noMembers'))
            : h('ul', { className: 'tr-rows' }, open.members.map((member) => memberRow(open.leadSessionId, member))))

      const body = status === 'loading' && open === undefined && index === undefined
        ? h('p', { className: 'tr-empty' }, t('loading'))
        : target === undefined || (known.length === 0 && currentSessionId === undefined)
          // No current-session signal and no roster anywhere: nothing per-session to name yet.
          ? h('p', { className: 'tr-empty' }, t('emptyProfile'))
          : open === undefined
            ? h('p', { className: 'tr-empty' }, t('loading'))
            : open.exists === false
              ? h('p', { className: 'tr-empty' }, t('empty'))
              : header

      return h('div', { className: 'tr-panel' },
        h('style', null, CSS),
        h('div', { className: 'tr-head' },
          h('div', null,
            h('h2', { className: 'tr-title' }, t('title')),
            h('p', { className: 'tr-sub' }, t('subtitle'))),
          h('div', { className: 'tr-actions' },
            h('button', {
              type: 'button',
              className: 'tr-btn',
              disabled: status === 'loading',
              onClick: () => void refresh(),
            }, t('refresh')))),
        picker,
        actionError === undefined ? null : h('p', { className: 'tr-note', role: 'alert' }, actionError),
        readError === undefined ? null : h('p', { className: 'tr-note', role: 'alert' }, readError),
        body)
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, DICTIONARIES), 'team-roster: dictionaries')
        const t = ctx.locale.bind(NS)
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'team-roster',
          order: SECTION_ORDER,
          label: () => t('nav'),
          locale: NS,
        }, TeamRosterPanel))
      },
    }
  },
})
