/**
 * The name guard: every identifier-shaped name in the living surface must be one the code declares.
 *
 * This lives beside `check.mjs` rather than inside it because the guard is the one section whose failure
 * message is worth testing, and `check.mjs` is a script that runs on import. `check.mjs` §10 gathers the
 * surface, calls `findUndeclared` and reports through its own `fail`; everything decidable without the
 * repository is here, where a unit test can drive it over a synthetic surface.
 *
 * **A dead name belongs in the record and must not be in the living surface.** `PROGRESS.md`,
 * `CHANGELOG.md`, `PLAN.md` and `docs/adr/**` keep what was true when they were written, so a name that no
 * longer exists is *correct* there; the published bundle, the locale files, the README pair and the
 * documentation pair are read as current, so a name that no longer exists there is a reader being told
 * something false.
 *
 * **There is deliberately no table of retired names.** A table only works if whoever renames something
 * remembers to add the old spelling, and the one time they forget the guard is silently dead. Reading the
 * declared names out of the code inverts the burden: a rename that leaves a reference behind makes that
 * reference undeclared, and the check fails without anyone registering anything.
 */

/**
 * The shape of a name this plugin declares: lowercase snake_case with at least one underscore.
 *
 * The narrowness is the point. A hyphen, a colon, an uppercase letter or a dot disqualifies a token, so
 * `dsh-team-relay`, `path:line`, `DSH_TEAM_ROSTER_DATA_DIR` and `archive.jsonl` never enter the comparison —
 * which is what keeps the check quiet enough to be read.
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

export const NAME_SHAPE = /[a-z][a-z0-9]*(?:_[a-z0-9]+)+/g

/**
 * Names that are not this plugin's to declare, each with the reason it is not one. Keep this short: every
 * entry is a claim, and a list that grows past a handful is a signal that the shape above is wrong rather
 * than that the list should grow.
 */
const FOREIGN_NAMES = [
  {
    match: /^(?:list_agents|send_message|interrupt_agent|subagent_fork|web_search|wait_agent)$/,
    reason: 'a tool the Harness ships; this plugin points at it, it does not declare it',
  },
  {
    match: /^(?:team_roster|team_task|team_task_(?:create|get|list|update)|spawn_teammate)$/,
    reason: 'a name of the shipped experimental team packages, kept where the docs say what this plugin replaces',
  },
  {
    match: /^(?:stop_reason|tool_use|web_search_tool_result)$/,
    reason: 'a provider wire field or value, not a name this code declares',
  },
  {
    match: /^working_directory$/,
    reason: 'a Harness concept named in a comment: the directory a Session runs in',
  },
]

/** The reason a token is not this plugin's, or undefined when it is not allowlisted. */
export function foreignReason(token) {
  return FOREIGN_NAMES.find((entry) => entry.match.test(token))?.reason
}

/**
 * The names the code declares, read out of `index.js` itself.
 *
 * Two forms cover the declared surface: a tool's `name: 'tool_name'`, and a schema property, which is a key
 * whose value is an object literal or a shared constant (`host_hooks: HOST_HOOKS_VALUE`). Reading them is
 * what makes a stale reference fail without a registry to maintain.
 * @param {string} indexText - the text of `index.js`.
 * @returns {Set<string>} the declared names.
 */
export function declaredNamesOf(indexText) {
  const declared = new Set()
  for (const match of (indexText ?? '').matchAll(/name:\s*'([a-z][a-z0-9_]*)'/g)) declared.add(match[1])
  for (const match of (indexText ?? '').matchAll(/^\s+'?([a-z][a-z0-9_]*)'?:\s*(?:\{|[A-Z][A-Z0-9_]*\s*,?\s*$)/gm)) {
    declared.add(match[1])
  }
  return declared
}

/**
 * Every name-shaped token a reader meets in one file, with the line it is on.
 *
 * The surface is deliberately narrower than the file: a token is only a candidate inside a backtick span in
 * a document, or inside a quoted or template string in code and locale files. That is where a name is
 * written *as a name* — prose about `task_board` is a claim about the tool, while the word `task` in a
 * sentence is not.
 * @param {string} text - the file text.
 * @param {boolean} markdown - whether the file is a document.
 * @returns {Array<{token: string, line: number}>} the candidates, in file order.
 */
export function candidatesIn(text, markdown) {
  const found = []
  for (const [index, line] of (text ?? '').split(/\r?\n/).entries()) {
    const spans = markdown
      ? [...line.matchAll(/`([^`]+)`/g)].map((match) => match[1])
      : [...line.matchAll(/'([^'\\]*)'|"([^"\\]*)"|`([^`\\]*)`/g)].map((match) => match[1] ?? match[2] ?? match[3] ?? '')
    for (const span of spans) {
      for (const token of span.match(NAME_SHAPE) ?? []) found.push({ token, line: index + 1 })
    }
  }
  return found
}

/** Levenshtein distance, small enough to inline: the suggestion is a courtesy, not a decision. */
function distance(left, right) {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index)
  for (let row = 1; row <= left.length; row += 1) {
    const current = [row]
    for (let column = 1; column <= right.length; column += 1) {
      const cost = left[row - 1] === right[column - 1] ? 0 : 1
      current[column] = Math.min(previous[column] + 1, current[column - 1] + 1, previous[column - 1] + cost)
    }
    previous = current
  }
  return previous[right.length]
}

/**
 * The declared name a reader probably meant, so the failure is a repair instruction rather than a search.
 * @param {string} token - the undeclared name.
 * @param {Iterable<string>} declared - the declared names.
 * @returns {string|undefined} the nearest name, when one is near enough to be worth naming.
 */
export function suggestionFor(token, declared) {
  let best
  let bestDistance = Number.POSITIVE_INFINITY
  for (const name of declared) {
    const score = distance(token, name)
    const sharesPrefix = token.slice(0, 4) === name.slice(0, 4)
    if (score < bestDistance && (score <= 3 || sharesPrefix)) {
      best = name
      bestDistance = score
    }
  }
  return best
}

/**
 * The living surface: the files a reader takes as current.
 *
 * The published bundle and its locale and template directories, the README pair, and the documentation pair.
 * The excluded files are named here rather than filtered out of a directory listing, because the exclusion
 * is the decision: `PROGRESS.md`, `CHANGELOG.md`, `PLAN.md` and `docs/adr/**` are the record.
 * @param {object} request
 * @param {string} request.root - the repository root.
 * @param {Iterable<string>} request.published - the manifest's `files` entries.
 * @param {Iterable<string>} request.docNames - the names in `docs/`.
 * @returns {Array<{path: string, text: string, markdown: boolean}>} the surface, each file with its text.
 */
export function collectLivingSurface({ root, published, docNames }) {
  const files = []
  const seen = new Set()
  const add = (relative) => {
    if (seen.has(relative)) return
    const full = join(root, relative)
    if (!existsSync(full) || statSync(full).isDirectory()) return
    const text = readFileSync(full, 'utf8').replace(/\r\n/g, '\n')
    seen.add(relative)
    files.push({ path: relative, text, markdown: relative.endsWith('.md') })
  }
  for (const entry of [...published].sort()) {
    const full = join(root, entry)
    if (!existsSync(full)) continue
    // npm reads a bare directory entry ("locale", "templates") as everything under it, so its files are
    // published and their names are part of the surface.
    if (statSync(full).isDirectory()) {
      for (const name of readdirSync(full).sort()) add(`${entry.replace(/\/+$/, '')}/${name}`)
      continue
    }
    add(entry)
  }
  for (const name of ['README.md', 'README-zh.md']) add(name)
  for (const name of docNames) if (!name.startsWith('adr')) add(`docs/${name}`)
  return files
}

/**
 * One problem as the line a reader repairs from: the file, the line, the name, and the name they probably
 * meant. A failure that only says "undeclared" makes the reader search; this one is an instruction.
 * @param {{path: string, line: number, token: string, nearest: string|undefined}} problem - what was found.
 * @returns {string} the message.
 */
export function formatProblem(problem) {
  const suggestion = problem.nearest === undefined ? '' : ` — did you mean "${problem.nearest}"?`
  return `${problem.path}:${problem.line}: "${problem.token}" is not a declared name${suggestion}`
}

/**
 * Every undeclared name in the living surface.
 *
 * One problem per file and token: a token repeated through a document is one repair, and a report that
 * repeats it buries the others. The count of what was compared is returned, not implied — a guard that
 * compares nothing passes for the wrong reason.
 * @param {object} request
 * @param {Array<{path: string, text: string, markdown?: boolean}>} request.files - the living surface.
 * @param {Set<string>} request.declared - the names the code declares.
 * @returns {{problems: Array<{path: string, line: number, token: string, nearest: string|undefined}>,
 *   scanned: number, compared: number}} what was found and how much was read.
 */
export function findUndeclared({ files, declared }) {
  const problems = []
  const seen = new Set()
  let scanned = 0
  let compared = 0
  for (const file of files) {
    if (typeof file?.text !== 'string') continue
    scanned += 1
    for (const { token, line } of candidatesIn(file.text, file.markdown === true)) {
      compared += 1
      if (declared.has(token) || foreignReason(token) !== undefined) continue
      const key = `${file.path}\u0000${token}`
      if (seen.has(key)) continue
      seen.add(key)
      problems.push({ path: file.path, line, token, nearest: suggestionFor(token, declared) })
    }
  }
  return { problems, scanned, compared }
}
