/**
 * Validate a tool result against the schema that tool declares for it.
 *
 * The host validates a result when the tool returns, and a property the operation produces but the schema
 * does not declare is rejected *after* the side effect has already happened. v0.13.0 shipped exactly that:
 * `spawn_member` answered with `transferred`, `MEMBER_ROW` did not declare it, and a replacement moved the
 * predecessor's work while the model was told the call failed. Every unit test stayed green because they
 * call `actions.js` directly and never go through a declared schema.
 *
 * Implements the subset the host accepts, which is also the subset `scripts/check.mjs` enforces. It is
 * shared by the entry tests and by the schema-check harness test, for the same reason the host's validator
 * is shared by every tool: one rule, and every value measured against it.
 */

import assert from 'node:assert/strict'

/**
 * @param {unknown} value - one value a tool returned.
 * @param {object} schema - the output schema that tool declares.
 * @param {string} [at] - the path to name in a failure, so a violation says where it is.
 */
export function assertMatchesSchema(value, schema, at = 'value') {
  if (schema.oneOf !== undefined) {
    const matched = schema.oneOf.filter((option) => {
      try {
        assertMatchesSchema(value, option, at)
        return true
      } catch {
        return false
      }
    })
    assert.equal(matched.length, 1, `${at}: expected exactly one oneOf branch, matched ${matched.length}`)
    return
  }
  const types = {
    object: () => value !== null && typeof value === 'object' && !Array.isArray(value),
    array: () => Array.isArray(value),
    string: () => typeof value === 'string',
    integer: () => Number.isInteger(value),
    number: () => typeof value === 'number' && Number.isFinite(value),
    boolean: () => typeof value === 'boolean',
    null: () => value === null,
  }
  assert.ok(types[schema.type]?.(value), `${at}: expected ${schema.type}, saw ${JSON.stringify(value)}`)
  if (schema.enum !== undefined) assert.ok(schema.enum.includes(value), `${at}: ${JSON.stringify(value)} is not in the enum`)
  if (schema.const !== undefined) assert.deepEqual(value, schema.const, `${at}: const`)
  if (schema.type === 'object') {
    for (const key of schema.required ?? []) assert.ok(key in value, `${at}: missing required "${key}"`)
    for (const [key, child] of Object.entries(value)) {
      if (child === undefined) continue
      const declared = schema.properties?.[key]
      if (declared === undefined) {
        assert.notEqual(schema.additionalProperties, false, `${at}.${key}: not declared in the output schema`)
        continue
      }
      assertMatchesSchema(child, declared, `${at}.${key}`)
    }
  }
  if (schema.type === 'array' && schema.items !== undefined) {
    value.forEach((item, index) => assertMatchesSchema(item, schema.items, `${at}[${index}]`))
  }
}
