/**
 * Member definitions: one markdown file per member, under `team/` in the Lead's working directory.
 *
 * A member was improvised in a tool call until this module existed: the prompt, the label and the
 * assignment lived only in that call and in the Lead's roster record, so a team could not be reviewed,
 * versioned or shared. A definition is the other half of that split — the member is a file on disk that
 * is committed with the project, and the roster stays runtime state. This module reads those files for
 * `spawn_member`; it never writes one, because version control and an editor are what make a file
 * better than a create/update tool (ADR 0018).
 *
 * The frontmatter is parsed here, without a YAML library: a profile-linked bundle cannot resolve
 * `@deepseek-ai/*` or `js-yaml` (ADR 0002). The accepted subset is therefore small and written down
 * rather than approximated — `key: value` lines between two `---` fences, optionally quoted, with no
 * nesting, no lists, no anchors, no block scalars and no duplicate keys. Anything outside it is refused
 * with the file path and the line, never coerced, because a silently misread field is a member that
 * runs with the wrong label or the wrong model.
 *
 * One bad file never hides the others: a scan collects the files it can read and reports the ones it
 * cannot, by path and line, so a spawn naming a valid definition still works while the broken file is
 * visible in the same result. That is the rule a stored task already follows (ADR 0017).
 *
 * No `@deepseek-ai/*` import: a profile-linked bundle cannot resolve those packages (ADR 0002).
 */

import { readFile, readdir, stat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'

import { checkAssignment, checkLabel, checkMemberName, handoffTemplateProblem } from './roster.js'

/**
 * The directory a definition lives in, relative to the Lead's working directory.
 *
 * It is resolved from the `workingDirectory` service, never from `process.cwd()`: a bundle runs in the
 * Harness process, whose launch directory is not the Lead's project, and guessing there would read the
 * wrong `team/` or none at all (ADR 0018).
 */
export const DEFINITION_DIR = 'team'

/**
 * The one team-scope file, beside the member definitions in the same `team/` directory.
 *
 * A member definition is a file whose frontmatter declares `name`; this file is the other half of the
 * split the survey found in CrewAI: the team's own settings, on disk and in review, while the roster
 * stays runtime state. Its body is the handoff-brief template, because a template is multi-line prose
 * that a flat `key: value` frontmatter cannot express; its frontmatter is deliberately empty for now, so
 * a field nobody asked for is refused instead of silently carried (ADR 0021).
 *
 * The name is **reserved**: the member-definition scan skips this exact file, so a `team.md` can never be
 * mistaken for a member definition. A member may still declare `name: team` in another file — the
 * filename is not an identity, and this reservation only keeps the team file out of the definition set.
 */
export const TEAM_FILE = 'team.md'

/**
 * Cap on one definition file, refused rather than truncated.
 *
 * The file holds a flat field block and a prompt; a cold child pays for every word of that prompt, so a
 * definition past this size is prose that belongs in a document the prompt points at. 16 KiB is two
 * orders of magnitude above the largest brief this plugin composes (`HANDOFF_BRIEF_MAX`, 2000), and it
 * bounds what one scan can be made to read.
 */
export const DEFINITION_FILE_MAX = 16 * 1024

/**
 * Cap on the definitions one scan reads, refused rather than truncated.
 *
 * The limit is on the directory, not a file: a scan that stopped at the 64th file would silently serve a
 * partial set, and a name missing from it is indistinguishable from a name somebody deleted. An
 * over-limit directory is therefore refused as a whole, which is the one refusal that is not per file.
 */
export const DEFINITION_LIMIT = 64

/**
 * The frontmatter fields a definition may declare, in the vocabulary `spawn_member` already uses.
 *
 * Every one of them is an input that tool already has: `name`, `label`, `assignment` and `ephemeral` are
 * its flat parameters, and `cwd`, `agent_preset` and the four `agent_options` fields are
 * `spawn_options`. The markdown body is the prompt, so `prompt` is not a field. A field with no
 * counterpart on the call — a description, a tools list, a priority — is out of scope, and declaring one
 * is refused by name with this list attached. The file's *name* is not a field either: the definition
 * declares `name`, which is also the key `spawn_member.definition` looks it up by.
 */
export const DEFINITION_FIELDS = [
  'name',
  'label',
  'assignment',
  'ephemeral',
  'cwd',
  'provider',
  'model',
  'reasoning_effort',
  'max_tokens',
  'agent_preset',
]

/** The reasons `spawn_member` answers a refused definition with, as a result rather than a throw. */
export const DEFINITION_REFUSAL_REASONS = [
  'working-directory-unavailable',
  'definition-not-found',
  'definition-invalid',
  'definitions-over-limit',
]

/** A frontmatter key: a bare identifier and a value introduced by one space. `key:value` is not a pair. */
const KEY_PATTERN = /^([A-Za-z][A-Za-z0-9_]*): (\S.*)$/

/** A key with nothing after the colon; refused rather than read as an empty string. */
const EMPTY_VALUE_PATTERN = /^([A-Za-z][A-Za-z0-9_]*):\s*$/

const FENCE = '---'

/** Render the accepted field set for a refusal, so an author never has to read this file. */
function acceptedFields() {
  return `the accepted fields are ${DEFINITION_FIELDS.join(', ')}`
}

/** Build one problem row. `line` is present only when the problem is a line of a file. */
function problem(path, message, line) {
  const row = { path, problem: message }
  if (line !== undefined) row.line = line
  return row
}

/**
 * Read the value of one frontmatter line, refusing everything outside the flat subset.
 *
 * The returned text is used exactly as written apart from one documented normalization: a value that is
 * quoted at both ends loses its delimiters, and no escape sequence is interpreted, so a definition
 * cannot mean something the author did not type.
 * @param {string} value - the text after `key: `.
 * @returns {{text: string}|{refusal: string}} the value, or the reason it is outside the subset.
 */
function readScalar(value) {
  if (/^[|>]/.test(value)) {
    return { refusal: 'a block scalar ("|" or ">") is not part of the accepted subset; put the text on the same line as the key' }
  }
  if (value.startsWith('&')) return { refusal: 'an anchor ("&name") is not part of the accepted subset' }
  if (value.startsWith('*')) return { refusal: 'an alias ("*name") is not part of the accepted subset' }
  if (/^[[{]/.test(value)) {
    return { refusal: 'a flow collection ("[...]" or "{...}") is not part of the accepted subset; every field is one scalar value' }
  }
  const quoted = /^['"]/.test(value)
  if (quoted) {
    const delimiter = value[0]
    if (value.length < 2 || !value.endsWith(delimiter)) {
      return { refusal: `the value opens with ${delimiter} but does not close with it` }
    }
    return { text: value.slice(1, -1) }
  }
  if (/['"]$/.test(value)) {
    return { refusal: 'the value ends with a quote it did not open with; quote it at both ends or remove it' }
  }
  return { text: value }
}

/**
 * Validate one field's value, so a definition cannot declare what `spawn_member` would refuse.
 * The roster's own validators bound the label and the assignment, so the caps cannot drift from the
 * ones the call enforces; every other field is a shape this file decides.
 * @param {string} key - one of `DEFINITION_FIELDS`.
 * @param {string} value - the scalar, already unquoted.
 * @returns {string|number|boolean} the value to store.
 */
function checkField(key, value) {
  if (key === 'name') return checkMemberName(value, 'definition')
  if (key === 'label') return checkLabel(value, 'definition')
  if (key === 'assignment') return checkAssignment(value, 'definition')
  if (key === 'ephemeral') {
    if (value !== 'true' && value !== 'false') {
      throw new Error(`ephemeral must be true or false, not ${JSON.stringify(value)}`)
    }
    return value === 'true'
  }
  if (key === 'max_tokens') {
    if (!/^[0-9]+$/.test(value) || Number(value) < 1 || Number(value) > Number.MAX_SAFE_INTEGER) {
      throw new Error(`max_tokens must be a positive integer, not ${JSON.stringify(value)}`)
    }
    return Number(value)
  }
  if (value.length === 0) throw new Error(`${key} must not be empty`)
  return value
}

/**
 * Parse the one frontmatter subset both kinds of file share.
 *
 * There is deliberately no second parser for the team file: the accepted subset, its refusals and the
 * line arithmetic are the same code, with the accepted field set and the value checker passed in. A
 * member definition accepts the fields `spawn_member` has; the team file accepts none yet, so every
 * field it could carry is refused by name rather than silently ignored.
 * @param {string} text - the file's contents.
 * @param {string} path - the file's path, reported in every refusal.
 * @param {{fields: string[], validate?: Function, describe: string, noun?: string}} options - the accepted
 *   field set, the per-field checker (absent when no field is accepted), the sentence an unknown field
 *   gets, and what to call the file in the opening-fence refusal.
 * @returns {{fields: object, declaredAt: object, close: number, lines: string[]}|{problem: object}} the
 *   parsed block, or the first refusal.
 */
function parseFrontmatter(text, path, { fields: accepted, validate, describe, noun = 'definition' }) {
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  const lines = source.split(/\r?\n/)
  if (lines[0] !== FENCE) {
    return { problem: problem(path, `a ${noun} must open with "${FENCE}" on line 1; found ${JSON.stringify(lines[0] ?? '')}`, 1) }
  }
  const close = lines.indexOf(FENCE, 1)
  if (close === -1) {
    return { problem: problem(path, `the frontmatter opened with "${FENCE}" is never closed by a "${FENCE}" line`, 1) }
  }
  const fields = {}
  const declaredAt = {}
  for (let index = 1; index < close; index += 1) {
    const line = lines[index]
    const lineNumber = index + 1
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue
    if (/^[ \t]/.test(line)) {
      return {
        problem: problem(
          path,
          'this line is indented, so it is a nested value or a block scalar; the accepted subset is one "key: value" per line with no indentation',
          lineNumber,
        ),
      }
    }
    if (line.startsWith('- ')) {
      return { problem: problem(path, 'a list item is not part of the accepted subset; every field is one scalar value', lineNumber) }
    }
    const empty = EMPTY_VALUE_PATTERN.exec(line)
    if (empty !== null) {
      if (empty[1] === '<<') return { problem: problem(path, 'a merge key ("<<") is not part of the accepted subset', lineNumber) }
      // A key with nothing after it is the shape a nested value takes, so the sentence says which of
      // the two the author wrote rather than only that the value is missing.
      const nested = /^[ \t]/.test(lines[index + 1] ?? '')
      const because = nested
        ? 'the value below it is indented, and the accepted subset is one "key: value" per line with no nesting'
        : 'write "key: value" or remove the line'
      return { problem: problem(path, `"${empty[1]}" has no value on this line: ${because}`, lineNumber) }
    }
    const match = KEY_PATTERN.exec(line)
    if (match === null) {
      return { problem: problem(path, `this line is not a "key: value" pair: ${JSON.stringify(line)}`, lineNumber) }
    }
    const [, key, raw] = match
    if (key === '<<') return { problem: problem(path, 'a merge key ("<<") is not part of the accepted subset', lineNumber) }
    if (!accepted.includes(key)) {
      return { problem: problem(path, `unknown field "${key}"; ${describe}`, lineNumber) }
    }
    if (declaredAt[key] !== undefined) {
      return { problem: problem(path, `"${key}" is declared twice; it was already declared on line ${declaredAt[key]}`, lineNumber) }
    }
    const scalar = readScalar(raw)
    if (scalar.refusal !== undefined) return { problem: problem(path, `${key}: ${scalar.refusal}`, lineNumber) }
    let value = scalar.text
    if (validate !== undefined) {
      try {
        value = validate(key, scalar.text)
      } catch (error) {
        return { problem: problem(path, error instanceof Error ? error.message : String(error), lineNumber) }
      }
    }
    fields[key] = value
    declaredAt[key] = lineNumber
  }
  return { fields, declaredAt, close, lines }
}

/**
 * Parse one definition file: its flat frontmatter and the markdown body that is the prompt.
 *
 * A refusal names the line the parser stopped on, because "something is wrong with this file" is not
 * actionable in a file an author edits by hand. Nothing is repaired: a value the subset cannot represent
 * is refused, never coerced into the closest thing.
 * @param {string} text - the file's contents.
 * @param {string} path - the file's path, reported in every refusal.
 * @returns {{definition: object}|{problem: object}} the definition, or the first refusal.
 */
export function parseDefinition(text, path) {
  const parsed = parseFrontmatter(text, path, {
    fields: DEFINITION_FIELDS,
    validate: checkField,
    describe: acceptedFields(),
  })
  if (parsed.problem !== undefined) return parsed
  const { fields, declaredAt, close, lines } = parsed
  if (fields.name === undefined) {
    return { problem: problem(path, `the frontmatter declares no "name"; ${acceptedFields()}`, 1) }
  }
  if (fields.label === undefined) {
    return { problem: problem(path, `the frontmatter declares no "label"; ${acceptedFields()}`, 1) }
  }
  const prompt = lines.slice(close + 1).join('\n').trim()
  if (prompt.length === 0) {
    return {
      problem: problem(
        path,
        'the markdown body after the closing "---" is the prompt, and it is empty',
        Math.min(close + 2, lines.length),
      ),
    }
  }
  return {
    definition: {
      name: fields.name,
      line: declaredAt.name,
      path,
      prompt,
      fields,
    },
  }
}

/**
 * Parse the team-scope file: an empty frontmatter block and the handoff template in the body.
 *
 * The body is validated by the same `handoffTemplateProblem` a stored template goes through, so a file
 * cannot smuggle an unknown placeholder, a missing `{assignment}` or an over-cap template past the rules
 * the tool enforces. A problem is reported with the file and, for a frontmatter problem, its line; the
 * template's own problems are not line-specific, so the row carries only the path.
 * @param {string} text - the file's contents.
 * @param {string} path - the file's path, reported in every refusal.
 * @returns {{team: {path: string, template: string}}|{problem: object}} the team template, or a refusal.
 */
export function parseTeamFile(text, path) {
  const parsed = parseFrontmatter(text, path, {
    fields: [],
    describe: 'the team file\'s frontmatter is reserved for team settings and accepts none yet; put the handoff template in the body',
    noun: 'team file',
  })
  if (parsed.problem !== undefined) return parsed
  const { close, lines } = parsed
  const template = lines.slice(close + 1).join('\n').trim()
  if (template.length === 0) {
    return {
      problem: problem(
        path,
        'the markdown body after the closing "---" is the handoff template, and it is empty',
        Math.min(close + 2, lines.length),
      ),
    }
  }
  const invalid = handoffTemplateProblem(template)
  if (invalid !== undefined) return { problem: problem(path, invalid) }
  return { team: { path, template } }
}

/**
 * Read every definition in one directory.
 *
 * A file that cannot be read, is past the size cap, or fails to parse becomes one problem row and the
 * scan continues; a name declared by two files refuses both, because a lookup that silently picked one
 * of them would make the other file's edits invisible.
 * @param {string} dir - the `team` directory of the Lead's working directory.
 * @returns {Promise<{definitions: Map<string, object>, problems: object[], over?: object}>} what the
 *   directory holds. `over` is present when the directory is past `DEFINITION_LIMIT`, in which case
 *   nothing was read at all.
 */
export async function scanDefinitions(dir) {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch (error) {
    // A missing directory is not an error: it is a Lead that keeps no definitions, and the caller
    // reports it as a definition that was not found.
    return error?.code === 'ENOENT'
      ? { definitions: new Map(), problems: [] }
      : { definitions: new Map(), problems: [problem(dir, error instanceof Error ? error.message : String(error))] }
  }
  const files = entries
    // `team.md` is the team-scope file, not a member definition, so the reservation is enforced here:
    // the two files would otherwise share one parse path, and a `team.md` would be reported as an
    // invalid definition (it declares no `name`) on every spawn. The filename is reserved; a member may
    // still declare `name: team` in any other file (ADR 0021).
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md') && entry.name !== TEAM_FILE)
    .map((entry) => entry.name)
    .sort()
  if (files.length > DEFINITION_LIMIT) {
    return {
      definitions: new Map(),
      problems: [],
      over: { count: files.length, limit: DEFINITION_LIMIT },
    }
  }
  const definitions = new Map()
  const refused = new Set()
  const problems = []
  for (const file of files) {
    const path = join(dir, file)
    let text
    try {
      const info = await stat(path)
      if (info.size > DEFINITION_FILE_MAX) {
        problems.push(problem(path, `the file is ${info.size} bytes; the cap is ${DEFINITION_FILE_MAX}, refused rather than truncated`))
        continue
      }
      text = await readFile(path, 'utf8')
    } catch (error) {
      problems.push(problem(path, error instanceof Error ? error.message : String(error)))
      continue
    }
    if (text.length > DEFINITION_FILE_MAX) {
      problems.push(problem(path, `the file is ${text.length} characters; the cap is ${DEFINITION_FILE_MAX}, refused rather than truncated`))
      continue
    }
    const parsed = parseDefinition(text, path)
    if (parsed.problem !== undefined) {
      problems.push(parsed.problem)
      continue
    }
    const { name } = parsed.definition
    if (refused.has(name)) continue
    const existing = definitions.get(name)
    if (existing !== undefined) {
      problems.push(problem(
        path,
        `the name "${name}" is also declared at ${existing.path}:${existing.line}; a name must be declared by one file, so neither definition is used`,
        parsed.definition.line,
      ))
      definitions.delete(name)
      refused.add(name)
      continue
    }
    definitions.set(name, parsed.definition)
  }
  return { definitions, problems }
}

/**
 * Resolve the Lead's working directory, or the reason it cannot be known.
 *
 * The service is `workingDirectory` and the method is `ensure`, which is the one the Harness's own spawn
 * path uses to resolve a child's directory: it validates the directory and repairs a vanished project,
 * so the `team/` a definition is read from is the same directory a relative `spawn_options.cwd` resolves
 * against. `ensure` is called on the *Lead* Agent, not on a child, because the definition belongs to the
 * Lead's project. The service is optional and read with `ctx.get`, exactly like `compaction`: a profile
 * without it must still activate this plugin, and a definition spawn in that profile is a typed refusal
 * rather than a guess at a directory.
 * @param {object} ctx - plugin context.
 * @param {object} agent - the live Lead Agent.
 * @param {AbortSignal|undefined} signal - cancellation for the service's filesystem check.
 * @returns {Promise<{dir: string}|{reason: string, message: string}>} the resolved `team` directory, or a
 *   refusal. The path is never guessed: an absent service and an unresolvable directory are both refused.
 */
export async function definitionDirectory(ctx, agent, signal) {
  const service = ctx.get?.('workingDirectory')
  if (service === undefined || service === null || typeof service.ensure !== 'function') {
    return {
      reason: 'working-directory-unavailable',
      message: 'This profile mounts no workingDirectory service, so the Lead\'s working directory cannot be known and no definition can be found. Pass label and prompt instead of definition, or define the member inline.',
    }
  }
  let cwd
  try {
    cwd = await service.ensure(agent, signal)
  } catch (error) {
    return {
      reason: 'working-directory-unavailable',
      message: `The Lead's working directory could not be resolved: ${error instanceof Error ? error.message : String(error)}. Pass label and prompt instead of definition, or define the member inline.`,
    }
  }
  if (typeof cwd !== 'string' || !isAbsolute(cwd)) {
    return {
      reason: 'working-directory-unavailable',
      message: `The workingDirectory service answered ${JSON.stringify(cwd)}, which is not an absolute directory, so no definition directory can be derived from it.`,
    }
  }
  return { dir: join(cwd, DEFINITION_DIR) }
}

/**
 * Read the one team-scope file, if the Lead's project has one.
 *
 * It reuses the member-definition directory resolution and its per-file cap. The frontmatter is parsed by
 * the same subset parser; only the body is different — it is the handoff template, validated by the
 * roster's own placeholder rules. A missing file is a normal profile, not an error. A file that exists
 * but cannot be read, is over the cap, or fails a rule is reported as `found: true` with a `problem`:
 * the caller must still know it exists, because it shadows the stored template even when it is broken.
 * @param {{ctx: object, agent: object, signal?: AbortSignal}} request - the plugin context, the live Lead
 *   Agent and cancellation for the directory check.
 * @returns {Promise<{found: false, path?: string}|{found: true, path: string, template?: string, problem?: object}>}
 *   the file's state. A profile without a usable `workingDirectory` service reports `found: false`: no
 *   team file can be seen from here, which is exactly how it behaved before this file existed.
 */
export async function loadTeamTemplate({ ctx, agent, signal }) {
  const resolved = await definitionDirectory(ctx, agent, signal)
  if (resolved.reason !== undefined) return { found: false }
  const path = join(resolved.dir, TEAM_FILE)
  let text
  try {
    const info = await stat(path)
    if (info.size > DEFINITION_FILE_MAX) {
      return {
        found: true,
        path,
        problem: problem(path, `the file is ${info.size} bytes; the cap is ${DEFINITION_FILE_MAX}, refused rather than truncated`),
      }
    }
    text = await readFile(path, 'utf8')
  } catch (error) {
    // ENOENT is the normal no-team-file profile. Any other read failure means something is there and
    // could not be read, so it is reported rather than treated as absence.
    if (error?.code === 'ENOENT') return { found: false, path }
    return { found: true, path, problem: problem(path, error instanceof Error ? error.message : String(error)) }
  }
  if (text.length > DEFINITION_FILE_MAX) {
    return {
      found: true,
      path,
      problem: problem(path, `the file is ${text.length} characters; the cap is ${DEFINITION_FILE_MAX}, refused rather than truncated`),
    }
  }
  const parsed = parseTeamFile(text, path)
  if (parsed.problem !== undefined) return { found: true, path, problem: parsed.problem }
  return { found: true, path, template: parsed.team.template }
}

/**
 * Read the one definition a spawn named.
 *
 * Every refusal is one shape — a reason, a sentence, and whatever the caller can act on — so the spawn
 * tool can answer it as a typed result instead of a thrown host error, which is the rule ADR 0016
 * already applies to a start the Harness refuses. `available` lists the names the same scan could
 * use, so a misspelled name is a refusal the model can correct without a second call to look the
 * directory up.
 * @param {{ctx: object, agent: object, name: string, signal?: AbortSignal}} request - the caller, the
 *   live Lead Agent and the definition name as the model wrote it.
 * @returns {Promise<{definition: object, dir: string, problems: object[]}|{refusal: object}>} the
 *   definition with the scan's other problems, or a typed refusal.
 */
export async function loadDefinition({ ctx, agent, name, signal }) {
  const resolved = await definitionDirectory(ctx, agent, signal)
  if (resolved.reason !== undefined) return { refusal: { reason: resolved.reason, message: resolved.message } }
  const { dir } = resolved
  const { definitions, problems, over } = await scanDefinitions(dir)
  if (over !== undefined) {
    return {
      refusal: {
        reason: 'definitions-over-limit',
        definition: name,
        path: dir,
        problems,
        message: `${JSON.stringify(dir)} holds ${over.count} markdown files; a scan reads at most ${over.limit}, and a partial set is never served. Move the definitions the Lead does not need into a subdirectory and retry.`,
      },
    }
  }
  const found = definitions.get(name)
  if (found === undefined) {
    // Two answers, and the difference is what the model should do next. A refused file is something to
    // fix, so the scan's problems decide: with a broken file in the directory the name may be declared
    // in the file that was refused, or the name may simply not exist — the sentence says both, and the
    // rows name the files and lines. Without one, the directory read cleanly and the name is a typo.
    const reason = problems.length === 0 ? 'definition-not-found' : 'definition-invalid'
    const declared = definitions.size === 0
      ? 'no definition is declared'
      : `the usable names are ${[...definitions.keys()].map((each) => `"${each}"`).join(', ')}`
    const refused = problems.length === 0
      ? ''
      : ` ${problems.length} file${problems.length === 1 ? ' was' : 's were'} refused; problems names the file and the line.`
    return {
      refusal: {
        reason,
        definition: name,
        path: dir,
        problems,
        available: [...definitions.keys()].sort(),
        message: `No usable member definition named "${name}" in ${JSON.stringify(dir)}; ${declared}.${refused} A definition is a markdown file with frontmatter in that directory, and each one declares its own name.`,
      },
    }
  }
  return { definition: found, dir, problems }
}
