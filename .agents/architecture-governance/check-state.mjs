#!/usr/bin/env node
import { existsSync, lstatSync, readFileSync } from 'node:fs'
import { dirname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const STATE = '.agents/architecture/state.json'
const SYSTEM_CONSTRAINTS = '.agents/architecture/system-constraints.json'

function fail(message) { throw new Error(message) }
function text(value, label) { if (typeof value !== 'string' || value.trim() === '' || /\0/u.test(value)) fail(`${label} must be a non-empty string`) }
function line(value, label) { text(value, label); if (/[\r\n]/u.test(value)) fail(`${label} must be a non-empty single-line string`) }
function object(value, label) { if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`) }
function safe(root, path, label = 'path') { line(path, label); const base = resolve(root); const target = resolve(base, path); if (target !== base && !target.startsWith(`${base}${sep}`)) fail(`path escapes project root: ${path}`); for (let current = target; current !== base; current = dirname(current)) if (existsSync(current) && lstatSync(current).isSymbolicLink()) fail(`path crosses a symbolic link: ${path}`); return target }
function regularFile(target, path, label) { if (!existsSync(target) || !lstatSync(target).isFile()) fail(`${label} must be an existing regular file: ${path}`); return readFileSync(target, 'utf8') }
function source(root, path, label = path) { return regularFile(safe(root, path, label), path, label) }
function json(target, path, label) { try { return JSON.parse(regularFile(target, path, label)) } catch (error) { fail(`${label} is invalid JSON: ${error instanceof Error ? error.message : String(error)}`) } }
function section(content, anchor, label) {
  const lines = content.split(/\r?\n/u)
  const index = lines.findIndex(line => /^#{1,6}\s+/u.test(line) && line.replace(/^#{1,6}\s+/u, '').trim() === anchor)
  if (index < 0) fail(`${label}.anchor is missing from ${label}.path`)
  const level = /^#+/u.exec(lines[index])?.[0].length ?? 1
  const end = lines.findIndex((line, lineIndex) => lineIndex > index && /^#{1,6}\s+/u.test(line) && (/^#+/u.exec(line)?.[0].length ?? 7) <= level)
  return lines.slice(index, end < 0 ? undefined : end).join('\n')
}
function locator(root, statePath, value, label) {
  object(value, label)
  line(value.path, `${label}.path`)
  text(value.locator, `${label}.locator`)
  const target = safe(root, value.path, `${label}.path`)
  if (target === statePath) fail(`${label}.path must not reference ${STATE}`)
  const content = regularFile(target, value.path, `${label}.path`)
  if (!content.includes(value.locator)) fail(`${label}.locator is missing from ${value.path}`)
}
function doc(root, value, label) {
  object(value, label)
  line(value.role, `${label}.role`)
  line(value.anchor, `${label}.anchor`)
  const content = source(root, value.path, `${label}.path`)
  return { ...value, section: section(content, value.anchor, label) }
}

function constraintReference(root, registryPath, value, label) {
  object(value, label)
  line(value.path, `${label}.path`)
  text(value.locator, `${label}.locator`)
  const target = safe(root, value.path, `${label}.path`)
  if (target === registryPath) fail(`${label}.path must not reference ${SYSTEM_CONSTRAINTS}`)
  const content = regularFile(target, value.path, `${label}.path`)
  if (!content.includes(value.locator)) fail(`${label}.locator is missing from ${value.path}`)
  return `${value.path}\n${value.locator}`
}

function constraintDocument(root, value, label) {
  object(value, label)
  line(value.path, `${label}.path`)
  line(value.anchor, `${label}.anchor`)
  const content = source(root, value.path, `${label}.path`)
  return { ...value, section: section(content, value.anchor, label) }
}

function verification(root, registryPath, value, label) {
  object(value, label)
  const key = constraintReference(root, registryPath, value, label)
  text(value.outcome, `${label}.outcome`)
  text(value.oracle, `${label}.oracle`)
  return key
}

function references(root, registryPath, value, label) {
  if (!Array.isArray(value) || value.length === 0) fail(`${label} is invalid`)
  const keys = value.map((entry, index) => constraintReference(root, registryPath, entry, `${label}[${index}]`))
  if (new Set(keys).size !== keys.length) fail(`${label} contains duplicate references`)
  return keys
}

function validateSystemConstraintsV1(root, registryPath, registry) {
  if (!Array.isArray(registry.constraints)) fail('system constraints.constraints is invalid')
  const ids = new Set()
  const entries = []
  registry.constraints.forEach((constraint, index) => {
    const label = `system constraints.constraints[${index}]`
    object(constraint, label)
    line(constraint.id, `${label}.id`)
    if (ids.has(constraint.id)) fail(`system constraints.constraints contains duplicate ${constraint.id}`)
    ids.add(constraint.id)
    if (!['candidate', 'active', 'retired'].includes(constraint.status)) fail(`${label}.status is invalid`)
    text(constraint.rule, `${label}.rule`)
    const document = constraintDocument(root, constraint.document, `${label}.document`)
    if (!document.section.includes(constraint.rule)) fail(`${label}.rule is missing from ${constraint.document.path}#${constraint.document.anchor}`)

    if (constraint.status === 'active') {
      const intent = references(root, registryPath, constraint.intentEvidence, `${label}.intentEvidence`)
      const current = references(root, registryPath, constraint.currentEvidence, `${label}.currentEvidence`)
      if (intent.some(key => current.includes(key))) fail(`${label} intentEvidence and currentEvidence must be distinct`)
      object(constraint.tests, `${label}.tests`)
      const normal = verification(root, registryPath, constraint.tests.normal, `${label}.tests.normal`)
      if (!Array.isArray(constraint.tests.variants) || constraint.tests.variants.length === 0) fail(`${label}.tests.variants is invalid`)
      const variants = constraint.tests.variants.map((entry, variantIndex) => verification(root, registryPath, entry, `${label}.tests.variants[${variantIndex}]`))
      if (new Set([normal, ...variants]).size !== variants.length + 1) fail(`${label}.tests contains duplicate test references`)
    }

    if (constraint.status === 'retired') {
      text(constraint.retirementReason, `${label}.retirementReason`)
      if (constraint.replacedBy !== undefined) line(constraint.replacedBy, `${label}.replacedBy`)
    }
    entries.push(constraint)
  })
  for (const constraint of entries) {
    if (constraint.status === 'retired' && constraint.replacedBy !== undefined) {
      const replacement = entries.find(entry => entry.id === constraint.replacedBy)
      if (replacement === undefined || replacement.status !== 'active') fail(`system constraint ${constraint.id} has no active replacement`)
    }
  }
}

function behaviorTest(root, registryPath, value, label) {
  object(value, label)
  const key = constraintReference(root, registryPath, value, label)
  text(value.oracle, `${label}.oracle`)
  return key
}

function validateSystemConstraintsV2(root, registryPath, registry) {
  object(registry.mvp, 'system constraints.mvp')
  text(registry.mvp.statement, 'system constraints.mvp.statement')
  const mvpDocument = constraintDocument(root, registry.mvp.document, 'system constraints.mvp.document')
  if (!mvpDocument.section.includes(registry.mvp.statement)) fail('system constraints.mvp.statement is missing from its document section')
  if (!Array.isArray(registry.constraints)) fail('system constraints.constraints is invalid')
  const ids = new Set()
  const behaviorIds = new Set()
  const entries = []
  registry.constraints.forEach((constraint, index) => {
    const label = `system constraints.constraints[${index}]`
    object(constraint, label)
    line(constraint.id, `${label}.id`)
    if (ids.has(constraint.id) || behaviorIds.has(constraint.id)) fail(`system constraints.constraints contains duplicate ${constraint.id}`)
    ids.add(constraint.id)
    if (!['candidate', 'active', 'retired'].includes(constraint.status)) fail(`${label}.status is invalid`)
    if (constraint.tests !== undefined) fail(`${label}.tests belongs to behavior constraints`)
    text(constraint.rule, `${label}.rule`)
    const document = constraintDocument(root, constraint.document, `${label}.document`)
    if (!document.section.includes(constraint.rule)) fail(`${label}.rule is missing from ${constraint.document.path}#${constraint.document.anchor}`)

    if (constraint.status === 'active') {
      const intent = references(root, registryPath, constraint.intentEvidence, `${label}.intentEvidence`)
      const current = references(root, registryPath, constraint.currentEvidence, `${label}.currentEvidence`)
      if (intent.some(key => current.includes(key))) fail(`${label} intentEvidence and currentEvidence must be distinct`)
    }

    if (constraint.behaviors !== undefined && !Array.isArray(constraint.behaviors)) fail(`${label}.behaviors is invalid`)
    const behaviors = constraint.behaviors ?? []
    const kinds = []
    const tests = []
    behaviors.forEach((behavior, behaviorIndex) => {
      const behaviorLabel = `${label}.behaviors[${behaviorIndex}]`
      object(behavior, behaviorLabel)
      line(behavior.id, `${behaviorLabel}.id`)
      if (behaviorIds.has(behavior.id) || ids.has(behavior.id)) fail(`system constraints contains duplicate behavior ${behavior.id}`)
      behaviorIds.add(behavior.id)
      if (!['normal', 'variant'].includes(behavior.kind)) fail(`${behaviorLabel}.kind is invalid`)
      kinds.push(behavior.kind)
      text(behavior.rule, `${behaviorLabel}.rule`)
      if (!document.section.includes(behavior.rule)) fail(`${behaviorLabel}.rule is missing from ${constraint.document.path}#${constraint.document.anchor}`)
      text(behavior.outcome, `${behaviorLabel}.outcome`)
      tests.push(behaviorTest(root, registryPath, behavior.test, `${behaviorLabel}.test`))
    })
    if (new Set(tests).size !== tests.length) fail(`${label}.behaviors contains duplicate test references`)
    if (constraint.status === 'active' && (!kinds.includes('normal') || !kinds.includes('variant'))) fail(`${label}.behaviors must include normal and variant behavior constraints`)

    if (constraint.status === 'retired') {
      text(constraint.retirementReason, `${label}.retirementReason`)
      if (constraint.replacedBy !== undefined) line(constraint.replacedBy, `${label}.replacedBy`)
    }
    entries.push(constraint)
  })
  for (const constraint of entries) {
    if (constraint.status === 'retired' && constraint.replacedBy !== undefined) {
      const replacement = entries.find(entry => entry.id === constraint.replacedBy)
      if (replacement === undefined || replacement.status !== 'active') fail(`system constraint ${constraint.id} has no active replacement`)
    }
  }
}

function validateSystemConstraints(root) {
  const registryPath = safe(root, SYSTEM_CONSTRAINTS, SYSTEM_CONSTRAINTS)
  if (!existsSync(registryPath)) return
  const registry = json(registryPath, SYSTEM_CONSTRAINTS, 'system constraints')
  object(registry, 'system constraints')
  if (registry.schemaVersion === 1) return validateSystemConstraintsV1(root, registryPath, registry)
  if (registry.schemaVersion === 2) return validateSystemConstraintsV2(root, registryPath, registry)
  fail('system constraints.schemaVersion must be 1 or 2')
}

function validateState(root, state, statePath) {
  object(state, 'architecture state')
  if (!['candidate', 'active'].includes(state.documentStatus)) fail('architecture state.documentStatus must be candidate or active')
  if (!Array.isArray(state.documents) || state.documents.length === 0 || !Array.isArray(state.items) || state.items.length === 0) fail('architecture state documents or items are invalid')
  if (!Array.isArray(state.openQuestions)) fail('architecture state.openQuestions is invalid')
  const openQuestions = state.openQuestions

  const documents = new Map()
  state.documents.forEach((value, index) => {
    const document = doc(root, value, `architecture state.documents[${index}]`)
    if (documents.has(document.role)) fail(`architecture state.documents contains duplicate ${document.role}`)
    documents.set(document.role, document)
  })
  if (!documents.has('overview')) fail('architecture state.documents must contain exactly one overview role')

  const ids = new Set()
  state.items.forEach((item, index) => {
    const label = `architecture state.items[${index}]`
    object(item, label)
    line(item.id, `${label}.id`)
    text(item.conclusion, `${label}.conclusion`)
    line(item.documentRole, `${label}.documentRole`)
    if (ids.has(item.id)) fail(`architecture state.items contains duplicate ${item.id}`)
    ids.add(item.id)
    const document = documents.get(item.documentRole)
    if (document === undefined) fail(`${label}.documentRole is unknown`)
    if (!document.section.includes(item.conclusion)) fail(`${label}.conclusion is missing from ${document.path}#${document.anchor}`)
    if (!Array.isArray(item.evidence) || item.evidence.length === 0) fail(`${label}.evidence is invalid`)
    item.evidence.forEach((value, itemIndex) => locator(root, statePath, value, `${label}.evidence[${itemIndex}]`))
  })

  openQuestions.forEach((item, index) => {
    const label = `architecture state.openQuestions[${index}]`
    object(item, label)
    text(item.question, `${label}.question`)
    if (item.critical !== undefined && typeof item.critical !== 'boolean') fail(`${label}.critical must be a boolean`)
  })
  return state
}

export function runArchitectureStateCheck(argv = process.argv.slice(2)) {
  const [command, ...rest] = argv
  if (command !== 'check') fail('command must be check')
  let requireActive = false
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index]
    if (flag === '--require-active') {
      if (requireActive) fail('duplicate --require-active')
      requireActive = true
    } else fail(`unsupported argument: ${flag}`)
  }
  const root = process.cwd()
  const statePath = safe(root, STATE, STATE)
  validateSystemConstraints(root)
  if (!existsSync(statePath)) {
    if (requireActive) fail('architecture state check is disabled; active baseline is required')
    process.stdout.write('architecture-state-check: architecture state check is disabled.\n')
    return 0
  }
  const state = validateState(root, json(statePath, STATE, 'architecture state'), statePath)
  const hasCriticalQuestion = state.openQuestions.some(item => item.critical)
  if (state.documentStatus === 'active' && hasCriticalQuestion) fail('active architecture state cannot contain critical open questions')
  if (requireActive && state.documentStatus !== 'active') fail(`architecture state must be active, found ${state.documentStatus}`)
  process.stdout.write(`architecture-state-check: architecture state is ${state.documentStatus}.\n`)
  return 0
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = runArchitectureStateCheck() } catch (error) { process.stderr.write(`architecture-state-check: ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1 }
}