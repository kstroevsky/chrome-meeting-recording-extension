import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import ts from 'typescript';

const ROOT = process.cwd();
const BACKGROUND = path.join(ROOT, 'src/background');
const MAX_LINES = 250;

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

function rawChromeOperations(file, sourceText) {
  const source = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const findings = [];

  function visit(node) {
    if (ts.isPropertyAccessExpression(node) && rootIdentifier(node) === 'chrome') {
      const { line, character } = source.getLineAndCharacterOfPosition(node.getStart(source));
      findings.push(`${relative(file)}:${line + 1}:${character + 1} ${node.getText(source)}`);
      return;
    }
    ts.forEachChild(node, visit);
  }

  visit(source);
  return findings;
}

const files = productionTypeScriptFiles(BACKGROUND);
const failures = [];

for (const file of files) {
  const rel = relative(file);
  const source = fs.readFileSync(file, 'utf8');
  const lineCount = source.split(/\r?\n/).length - (source.endsWith('\n') ? 1 : 0);

  if (!rel.includes('/')) {
    failures.push(`${rel}: production TypeScript must live in a feature package, not background/ root`);
  }

  if (lineCount > MAX_LINES && !LINE_LIMIT_EXCEPTIONS.has(rel)) {
    failures.push(`${rel}: ${lineCount} lines exceeds the ${MAX_LINES}-line background target`);
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
  if (!fs.existsSync(file)) failures.push(`${rel}: stale line-limit exception (${reason})`);
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
