/*
 * Finds hooks that are called conditionally because an early `return` sits
 * above them in the same function body. That mistake unmounts the whole tree
 * at runtime ("Rendered more hooks than during the previous render"), which is
 * exactly how the playlist page turned grey.
 *
 * Uses the TypeScript AST rather than line matching, so a `return` inside a
 * nested callback or a JSX arrow is not mistaken for an early return.
 *
 * Exits non-zero when it finds something. Without that the check is decorative
 * in CI, which is how it went unrun for so long.
 */
const ts = require('typescript')
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const SRC = path.join(ROOT, 'src')
/** GitHub renders these as inline annotations on the offending line. */
const ANNOTATE = process.env.GITHUB_ACTIONS === 'true'

function isHookCall(node) {
  if (!ts.isCallExpression(node)) return false
  const callee = node.expression
  if (ts.isIdentifier(callee)) return /^use[A-Z]/.test(callee.text)
  // React.useState(...)
  if (ts.isPropertyAccessExpression(callee)) return /^use[A-Z]/.test(callee.name.text)
  return false
}

/** True when this statement calls a hook anywhere in its own expression. */
function statementCallsHook(stmt) {
  let found = false
  const visit = (n) => {
    if (found) return
    if (isHookCall(n)) {
      found = true
      return
    }
    ts.forEachChild(n, visit)
  }
  visit(stmt)
  return found
}

/** True when this statement is (or wraps) a `return` at this level. */
function statementReturns(stmt) {
  if (ts.isReturnStatement(stmt)) return true
  if (ts.isIfStatement(stmt)) {
    const branches = [stmt.thenStatement, stmt.elseStatement].filter(Boolean)
    return branches.some((b) => {
      if (ts.isBlock(b)) return b.statements.some((s) => ts.isReturnStatement(s))
      return ts.isReturnStatement(b)
    })
  }
  return false
}

function functionName(node) {
  if (node.name && ts.isIdentifier(node.name)) return node.name.text
  const parent = node.parent
  if (parent && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text
  if (parent && ts.isPropertyAssignment(parent)) return parent.name.getText()
  return '(anonymous)'
}

function relative(file) {
  return path.relative(ROOT, file).split(path.sep).join('/')
}

const problems = []
const files = []
const walk = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full)
    else if (/\.tsx?$/.test(entry.name)) files.push(full)
  }
}
walk(SRC)

for (const file of files) {
  const text = fs.readFileSync(file, 'utf8')
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)

  const checkFunction = (node) => {
    const body = node.body
    if (!body || !ts.isBlock(body)) return
    let returnedAt = null
    for (const stmt of body.statements) {
      if (statementCallsHook(stmt)) {
        if (returnedAt !== null) {
          const { line } = sf.getLineAndCharacterOfPosition(stmt.getStart(sf))
          const { line: rl } = sf.getLineAndCharacterOfPosition(returnedAt.getStart(sf))
          problems.push({
            file,
            line: line + 1,
            fn: functionName(node),
            returnLine: rl + 1,
            text: stmt.getText(sf).split('\n')[0].slice(0, 60),
          })
        }
      } else if (returnedAt === null && statementReturns(stmt)) {
        returnedAt = stmt
      }
    }
  }

  const visit = (node) => {
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isMethodDeclaration(node)
    ) {
      checkFunction(node)
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
}

if (problems.length === 0) {
  console.log('OK - no hook is called after an early return')
} else {
  for (const p of problems) {
    const where = relative(p.file)
    console.log(`PROBLEM ${where}:${p.line} in ${p.fn}() - hook after return at line ${p.returnLine}`)
    console.log(`        ${p.text}`)
    if (ANNOTATE) {
      console.log(
        `::error file=${where},line=${p.line}::${p.fn}() calls a hook after the return on line ${p.returnLine}`,
      )
    }
  }
  console.log(`\n${problems.length} problem(s)`)
  process.exitCode = 1
}
