// Ensure literal UI messages have English translations. Comments, user data,
// parser patterns and model prompts are deliberately outside this check.
import fs from 'node:fs';
import path from 'node:path';
import { parse } from '@babel/parser';

const catalog = JSON.parse(fs.readFileSync('src/shared/i18n/en.json', 'utf8'));
const files = ['src/shared/replay.ts', 'desktop/src/bun/app/menu.ts', 'src/shared/i18n/react.tsx'];
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(file);
    else if (/\.tsx?$/.test(file)) files.push(file);
  }
}
walk('src/web');
walk('desktop/src/shell');
const missing = [];
let checked = 0;
for (const file of files) {
  const ast = parse(fs.readFileSync(file, 'utf8'), { sourceType: 'module', plugins: ['typescript', 'jsx'] });
  function visit(node, ancestors = []) {
    if (!node || typeof node !== 'object') return;
    let key;
    const parent = ancestors.at(-1);
    if (node.type === 'CallExpression' && node.callee.name === 'tr' && node.arguments[0]?.type === 'StringLiteral') key = node.arguments[0].value;
    if (node.type === 'TaggedTemplateExpression' && node.tag.name === 'tr') {
      key = node.quasi.quasis.map((part, i) => (part.value.cooked ?? '') + (i < node.quasi.expressions.length ? `{${i}}` : '')).join('');
    }
    if (node.type === 'StringLiteral' && ancestors.some((a) => a.type === 'CallExpression' && a.callee.name === 'localized') && /\p{Script=Han}/u.test(node.value)) key = node.value;
    if (key !== undefined) {
      checked++;
      if (!Object.hasOwn(catalog, key)) missing.push(`${file}:${node.loc.start.line}: missing translation: ${key}`);
    }
    if (node.type === 'JSXText' && /\p{Script=Han}/u.test(node.value) && node.value.trim() !== '简体中文') missing.push(`${file}:${node.loc.start.line}: unlocalized JSX text`);
    if (node.type === 'StringLiteral' && parent?.type === 'JSXAttribute' && /\p{Script=Han}/u.test(node.value)) missing.push(`${file}:${node.loc.start.line}: unlocalized JSX attribute`);
    for (const [key, value] of Object.entries(node)) {
      if (/comment|loc/i.test(key)) continue;
      if (Array.isArray(value)) value.forEach((child) => visit(child, [...ancestors, node]));
      else if (value && typeof value === 'object') visit(value, [...ancestors, node]);
    }
  }
  visit(ast);
}
if (missing.length) {
  console.error(missing.join('\n'));
  process.exit(1);
}
console.log(`i18n: ${checked} message references checked across ${files.length} files`);
