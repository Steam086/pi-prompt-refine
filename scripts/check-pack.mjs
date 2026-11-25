import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const run = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8' });
const [pack] = JSON.parse(run(process.execPath, [process.env.npm_execpath, 'pack', '--offline', '--dry-run', '--json', '--ignore-scripts']));
const sources = run('git', ['ls-files', '-z', '--', 'src']).split('\0').filter(path => path.endsWith('.ts'));
const expected = [...sources, 'src/extension.ts', 'package.json', 'LICENSE', 'CHANGELOG.md', 'SECURITY.md',
  'README.md', 'README.zh-CN.md', 'docs/tui-guide.md', 'examples/prompt-refine.json', 'examples/prompt-refine-preferences.json'];
const actual = pack.files.map(file => file.path).sort();
assert.deepEqual(actual, [...new Set(expected)].sort(), 'Unexpected or missing npm package files');
const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
assert.deepEqual(manifest.pi.extensions, ['./src/extension.ts']);
assert.ok(manifest.keywords.includes('pi-package'));
assert.ok(JSON.parse(readFileSync('packages/pi-web/package.json', 'utf8')).private);

const sensitive = /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----|\b(?:npm_|ghp_|github_pat_|sk-proj-)[\w-]{20,}|\bAKIA[A-Z0-9]{16}|\/(?:home|Users)\/[^/\s<>]+\//;
for (const path of actual) {
  assert.ok(!sensitive.test(readFileSync(path, 'utf8')), `Review potential private material in ${path} (value withheld)`);
}
console.log(`${pack.id}: ${actual.length} reviewed paths, ${pack.size} bytes packed; Web and local data excluded.`);
