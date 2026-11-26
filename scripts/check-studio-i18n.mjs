/** Verify Studio dictionary parity and reject new hard-coded interface copy. */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript-classic';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const copyNames = new Set([
  'title',
  'label',
  'placeholder',
  'description',
  'tooltip',
  'aria-label',
  'alt',
  'emptyText',
  'emptyMessage',
  'loadingText',
  'confirmText',
  'cancelText',
  'searchPlaceholder',
  'header',
  'info',
  'message',
  'helperText',
  'emptyLabel',
  'tooltipContent',
  'confirmLabel',
  'cancelLabel',
  'loadingMessage',
  'noResultsText',
]);
for (const name of [
  'titleSlot',
  'descriptionSlot',
  'subtitle',
  'leftDrawerLabel',
  'dialogTitle',
  'previousLabel',
  'nextLabel',
  'expandLabel',
  'dialogDescription',
  'submitButtonLabel',
  'copyMessage',
  'errorTitle',
  'memoryLabel',
  'valueLabel',
  'emptyState',
  'resourceLabel',
  'closeLabel',
  'empty',
  'deleteLabel',
  'buttonText',
  'inputTypeLabel',
  'removeLabel',
  'ariaLabel',
  'submitLabel',
  'caption',
  'clearLabel',
])
  copyNames.add(name);
const codeTags = new Set([
  'code',
  'pre',
  'InlineCode',
  'Code',
  'CodeBlock',
  'JsonEditor',
  'JSONSchemaTable',
  'SchemaDisplay',
  'MarkdownRenderer',
  'Markdown',
]);
// Names and protocol notation do not change with the interface language.
const invariant =
  /^(?:k|Altflow|JSON|API|MCP|SDK|URL|ID|CSV|TypeScript|JavaScript|SQL|OAuth|UTF-8|Ctrl|CMD|GitHub|Discord|Slack|OpenAI|Anthropic|Google|CodeMirror|Mermaid|Markdown|npm|pnpm|npx|yarn|English)$/;
const isCopy = text =>
  /[a-zA-Z]/.test(text.replace(/\{\w+\}/g, '').replace(/&(?:nbsp|amp|lt|gt|quot);/g, '')) &&
  !invariant.test(text.trim()) &&
  !/^\[--[\w-]+:[^\]\r\n]+\]$/.test(text.trim()) &&
  !/^(?:text|bg)-[\w/-]+(?: (?:text|bg)-[\w/-]+)*$/.test(text.trim()) &&
  !/^\s*(?:https?:\/\/|[\w./-]+\.(?:ts|tsx|js|json)|\/?api\/|--|@mastra\/)/.test(text);

export function findHardcodedCopy(file, source) {
  const sf = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const violations = [];
  function inCode(node) {
    for (let p = node.parent; p; p = p.parent) {
      if (ts.isJsxElement(p) && codeTags.has(p.openingElement.tagName.getText(sf))) return true;
    }
    return false;
  }
  function copyExpression(node) {
    // These labels are dispatch keys or chart modes, translated only at display boundaries.
    if (
      (file.endsWith('/ds/tokens/colors.ts') && node.text === 'var(--placeholder)') ||
      (file.endsWith('/LogStream/log-level-styles.ts') && node.text === 'before:bg-info-indicator')
    )
      return false;
    if (file.endsWith('/tool-styles.ts') || file.endsWith('/ds/primitives/text.ts')) return false;
    if (ts.isBindingElement(node.parent) && node.parent.name.getText(sf) === 'xLabels') return false;
    if (
      file.endsWith('/LogsDataList/logs-data-list-cells.tsx') &&
      ts.isPropertyAssignment(node.parent) &&
      node.parent.name.getText(sf) === 'info'
    )
      return false;
    const p = node.parent;
    if (ts.isJsxAttribute(p)) return copyNames.has(p.name.getText(sf));
    if (ts.isPropertyAssignment(p))
      return (
        p.initializer === node &&
        (copyNames.has(p.name.getText(sf).replace(/^['"]|['"]$/g, '')) ||
          (file.endsWith('/nav-items.tsx') && p.name.getText(sf) === 'name'))
      );
    if (ts.isBindingElement(p) || ts.isParameter(p))
      return (
        p.initializer === node && /label|placeholder|description|tooltip|title|emptyText/i.test(p.name.getText(sf))
      );
    if (ts.isCallExpression(p))
      return (
        /^toast\.(?:error|success|info|warning|loading|message)$/.test(p.expression.getText(sf)) &&
        p.arguments[0] === node
      );
    if (ts.isJsxExpression(p)) return !ts.isJsxAttribute(p.parent) || copyNames.has(p.parent.name.getText(sf));
    if (ts.isConditionalExpression(p) && p.condition !== node) return copyExpression(p);
    if (ts.isParenthesizedExpression(p)) return copyExpression(p);
    if (
      ts.isBinaryExpression(p) &&
      [ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.AmpersandAmpersandToken].includes(
        p.operatorToken.kind,
      )
    )
      return copyExpression(p);
    return false;
  }
  function visit(node) {
    if (inCode(node)) return;
    let text;
    if (ts.isJsxText(node)) text = node.text;
    if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && copyExpression(node))
      text = node.text;
    if (ts.isTemplateExpression(node) && copyExpression(node))
      text = node.head.text + node.templateSpans.map(span => '{value}' + span.literal.text).join('');
    if (text !== undefined && isCopy(text.trim())) {
      violations.push(
        `${file}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}: ${text.trim().replace(/\s+/g, ' ').slice(0, 100)}`,
      );
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  return violations;
}

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = join(directory, entry.name);
    if (entry.isDirectory())
      return ['__tests__', 'test', 'tests', 'icons', 'i18n'].includes(entry.name) ? [] : sourceFiles(file);
    return /\.tsx?$/.test(file) && !/\.(test|spec|stories)\.[^.]+$|\.d\.ts$/.test(file) ? [file] : [];
  });
}

function dictionary(name) {
  const file = join(root, 'packages/playground-ui/src/lib/i18n/messages', `${name}.ts`);
  const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const values = new Map();
  function visit(node) {
    if (
      ts.isPropertyAssignment(node) &&
      (ts.isStringLiteral(node.name) || ts.isIdentifier(node.name)) &&
      ts.isStringLiteral(node.initializer)
    )
      values.set(node.name.text, node.initializer.text);
    ts.forEachChild(node, visit);
  }
  visit(sf);
  if (values.size < 3000)
    throw new Error(`${name}: dictionary discovery unexpectedly narrowed to ${values.size} messages`);
  return values;
}

export function checkDictionaries(en, zh) {
  const issues = [];
  const tokens = text => (text.match(/\{\w+\}/g) ?? []).sort().join('|');
  for (const [key, text] of en) {
    const value = zh.get(key);
    // Chinese has no English plural suffix. This grammar token is intentionally empty.
    if (value === undefined || (value.trim() === '' && key !== 'English plural suffix'))
      issues.push(`Missing Chinese translation: ${key}`);
    else if (tokens(text) !== tokens(value)) issues.push(`Translation changed placeholders: ${key}`);
  }
  for (const key of zh.keys()) if (!en.has(key)) issues.push(`Unknown Chinese message: ${key}`);
  return issues;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const files = ['playground', 'playground-ui'].flatMap(name => sourceFiles(join(root, 'packages', name, 'src')));
  if (files.length < 1500) throw new Error(`Studio source discovery unexpectedly narrowed to ${files.length} files`);
  const errors = [
    ...checkDictionaries(dictionary('en'), dictionary('zh')),
    ...files.flatMap(file => findHardcodedCopy(relative(root, file), readFileSync(file, 'utf8'))),
  ];
  if (errors.length) {
    console.error(errors.join('\n'));
    process.exitCode = 1;
  } else console.log(`Studio i18n: ${dictionary('en').size} bilingual messages; ${files.length} source files checked.`);
}
