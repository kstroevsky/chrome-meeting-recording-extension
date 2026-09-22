import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import ts from 'typescript';

const ROOT = process.cwd();
const BACKGROUND = path.join(ROOT, 'src/background');
const ENTRYPOINT = path.join(ROOT, 'src/background.ts');
const MAX_LINES = 250;
const MAX_ENTRYPOINT_LINES = 100;

const LINE_LIMIT_EXCEPTIONS = new Map([
  [
    'library/analysis/RecordingAnalysisCoordinator.ts',
    '271-line cohesive analysis orchestration; split only when another real responsibility emerges.',
  ],
]);

function productionTypeScriptFiles(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '__tests__') continue;
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...productionTypeScriptFiles(absolute));
    else if (entry.isFile() && entry.name.endsWith('.ts')) files.push(absolute);
  }
  return files;
}

function relative(file) {
  return path.relative(BACKGROUND, file).split(path.sep).join('/');
}

function rootIdentifier(expression) {
  let current = expression;
  while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
    current = current.expression;
  }
  return ts.isIdentifier(current) ? current.text : null;
}

function rawChromeOperations(file, sourceText, allow = () => false) {
  const source = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const findings = [];

  function visit(node) {
    if (ts.isPropertyAccessExpression(node) && rootIdentifier(node) === 'chrome') {
      if (allow(node)) return;
      const { line, character } = source.getLineAndCharacterOfPosition(node.getStart(source));
      const label = file === ENTRYPOINT ? 'background.ts' : relative(file);
      findings.push(`${label}:${line + 1}:${character + 1} ${node.getText(source)}`);
      return;
    }
    ts.forEachChild(node, visit);
  }

  visit(source);
  return findings;
}

function lineCount(source) {
  return source.split(/\r?\n/).length - (source.endsWith('\n') ? 1 : 0);
}

const files = productionTypeScriptFiles(BACKGROUND);
const failures = [];

for (const file of files) {
  const rel = relative(file);
  const source = fs.readFileSync(file, 'utf8');
  const lines = lineCount(source);

  if (!rel.includes('/')) {
    failures.push(`${rel}: production TypeScript must live in a feature package, not background/ root`);
  }

  if (lines > MAX_LINES && !LINE_LIMIT_EXCEPTIONS.has(rel)) {
    failures.push(`${rel}: ${lines} lines exceeds the ${MAX_LINES}-line background target`);
  }

  if (rel.startsWith('library/')) {
    const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    for (const statement of sourceFile.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
      const specifier = statement.moduleSpecifier.text;
      if (/(^|\/)runtime(\/|$)/.test(specifier)) {
        failures.push(`${rel}: library must not import runtime (${specifier})`);
      }
    }
  }

  for (const finding of rawChromeOperations(file, source)) {
    failures.push(`${finding}: raw Chrome operation; use platform/chrome`);
  }
}

for (const [rel, reason] of LINE_LIMIT_EXCEPTIONS) {
  const file = path.join(BACKGROUND, rel);
  if (!fs.existsSync(file)) {
    failures.push(`${rel}: stale line-limit exception (${reason})`);
    continue;
  }
  const lines = lineCount(fs.readFileSync(file, 'utf8'));
  if (lines <= MAX_LINES) {
    failures.push(`${rel}: stale line-limit exception; file is now ${lines} lines (${reason})`);
  }
}

if (!fs.existsSync(ENTRYPOINT)) {
  failures.push('background.ts: MV3 entrypoint is missing');
} else {
  const source = fs.readFileSync(ENTRYPOINT, 'utf8');
  const lines = lineCount(source);
  if (lines > MAX_ENTRYPOINT_LINES) {
    failures.push(`background.ts: ${lines} lines exceeds the ${MAX_ENTRYPOINT_LINES}-line entrypoint target`);
  }
  const sourceFile = ts.createSourceFile(
    ENTRYPOINT,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) {
      failures.push('background.ts: domain/business declarations belong under background/ feature packages');
    }
  }
  for (const finding of rawChromeOperations(ENTRYPOINT, source, (node) => (
    node.name.text === 'addListener'
    && ts.isCallExpression(node.parent)
    && node.parent.expression === node
  ))) {
    failures.push(`${finding}: raw Chrome operation; entrypoint may only register listeners`);
  }
}

if (failures.length) {
  console.error('Background architecture check failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`Background architecture check passed (${files.length} production TypeScript files).`);
  for (const [rel, reason] of LINE_LIMIT_EXCEPTIONS) {
    console.log(`Accepted size exception: ${rel} — ${reason}`);
  }
}
