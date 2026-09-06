import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
const script = fileURLToPath(new URL('../tools/prepare-upload.mjs', import.meta.url));
const required = ['package.json', 'package-lock.json', 'tsconfig.json', 'README.md', 'index.html', '.gitignore', '.gitattributes', '.github/workflows/reports.yml'];

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'tase-upload-'));
  for (const file of [...required, 'src/index.ts', 'tests/example.test.ts', 'tools/report-summary.mjs', 'reports/report-daily-2026-09-06.html',
    'node_modules/dependency/index.js', 'node_modules - Copy/dependency/index.js', '.cache/candles.sqlite', '.git/config', '.vscode/settings.json', '.env', 'daily-run.log']) {
    await mkdir(join(root, file, '..'), { recursive: true });
    await writeFile(join(root, file), `fixture: ${file}`);
  }
  const database = new DatabaseSync(join(root, 'reports/state.sqlite'));
  database.exec('CREATE TABLE documents (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  database.prepare('INSERT INTO documents VALUES (?, ?)').run('pick-history', '{"preserved":true}');
  database.close();
  return root;
}

async function filesAt(root: string, prefix = ''): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await filesAt(root, relative));
    else files.push(relative);
  }
  return files.sort();
}

test('upload folder contains only runnable project files and a readable history snapshot', async () => {
  const root = await fixture();
  try {
    execFileSync(process.execPath, [script, '--root', root], { encoding: 'utf8', stdio: 'pipe' });
    const output = join(root, 'github-upload');
    assert.deepEqual(await filesAt(output), [...required, 'src/index.ts', 'tests/example.test.ts', 'tools/report-summary.mjs', 'reports/report-daily-2026-09-06.html', 'reports/state.sqlite'].sort());
    assert.equal(await readFile(join(output, 'src/index.ts'), 'utf8'), 'fixture: src/index.ts');
    const snapshot = new DatabaseSync(join(output, 'reports/state.sqlite'), { readOnly: true });
    try { assert.equal(snapshot.prepare('SELECT value FROM documents WHERE key = ?').get('pick-history').value, '{"preserved":true}'); }
    finally { snapshot.close(); }
    assert.equal(await readFile(join(root, '.env'), 'utf8'), 'fixture: .env');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('over-budget upload is rejected before creating an export directory', async () => {
  const root = await fixture();
  try {
    for (let index = 0; index < 101; index++) await writeFile(join(root, `src/extra-${index}.ts`), 'export {};');
    assert.throws(() => execFileSync(process.execPath, [script, '--root', root], { stdio: 'pipe' }), /100/);
    await assert.rejects(access(join(root, 'github-upload')), { code: 'ENOENT' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('existing upload directory is never overwritten or deleted', async () => {
  const root = await fixture();
  try {
    await mkdir(join(root, 'github-upload'));
    await writeFile(join(root, 'github-upload', 'user-file.txt'), 'keep me');
    assert.throws(() => execFileSync(process.execPath, [script, '--root', root], { stdio: 'pipe' }), /exists/);
    assert.equal(await readFile(join(root, 'github-upload', 'user-file.txt'), 'utf8'), 'keep me');
  } finally { await rm(root, { recursive: true, force: true }); }
});