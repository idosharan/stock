import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, access, truncate } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
const script = fileURLToPath(new URL('../tools/prepare-upload.mjs', import.meta.url));
const maintenance = fileURLToPath(new URL('../tools/storage-maintenance.ts', import.meta.url));
const loader = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
const required = ['package.json', 'package-lock.json', 'tsconfig.json', 'README.md', 'index.html', '.gitignore', '.gitattributes', '.github/workflows/reports.yml', 'data/instruments.json'];
const summaries = ['latest-daily.txt', 'latest-weekly.txt', 'latest-daily-ai.txt', 'latest-weekly-ai.txt'];

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'tase-upload-'));
  for (const file of [...required, 'src/index.ts', 'tests/example.test.ts', 'tools/report-summary.mjs', 'reports/report-daily-2026-09-06.html',
    'node_modules/dependency/index.js', 'node_modules - Copy/dependency/index.js', '.cache/candles.sqlite', '.cache/automation-state.json', '.git/config', '.vscode/settings.json', '.env', 'daily-run.log',
    '_site/index.html', '_site/reports/latest-daily.txt', 'github-upload-old/src/private.ts', 'data/private.json', 'docs/private.md']) {
    await mkdir(join(root, file, '..'), { recursive: true });
    await writeFile(join(root, file), `fixture: ${file}`);
  }
  await writeFile(join(root, 'package.json'), JSON.stringify({ type: 'module' }));
  await writeFile(join(root, 'data/instruments.json'), JSON.stringify({ version: 1, watchlist: [], portfolio: [], stockSectors: {} }));
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

test('dated output is a fresh root-local snapshot and never overwrites either export', async () => {
  const root = await fixture();
  try {
    execFileSync(process.execPath, [script, '--root', root], { stdio: 'pipe' });
    const original = await readFile(join(root, 'github-upload/reports/state.sqlite'));
    const args = [script, '--root', root, '--output', 'github-upload-2026-09-07'];
    const stdout = execFileSync(process.execPath, args, { encoding: 'utf8', stdio: 'pipe' });
    const output = join(root, 'github-upload-2026-09-07');
    assert.match(stdout, /github-upload-2026-09-07/);
    assert.deepEqual(await filesAt(output), await filesAt(join(root, 'github-upload')));
    assert.deepEqual(await readFile(join(output, 'data/instruments.json')), await readFile(join(root, 'data/instruments.json')));
    await writeFile(join(output, 'user-file.txt'), 'preserve this snapshot');
    assert.throws(() => execFileSync(process.execPath, args, { stdio: 'pipe' }), /exists/);
    assert.equal(await readFile(join(output, 'user-file.txt'), 'utf8'), 'preserve this snapshot');
    assert.deepEqual(await readFile(join(root, 'github-upload/reports/state.sqlite')), original);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('output rejects paths and names outside the snapshot namespace before copying', async () => {
  const root = await fixture();
  try {
    for (const output of ['', '../github-upload-escape', 'github-upload/child', 'github-upload\\child', join(root, 'github-upload-absolute'), 'reports', 'github-upload-..']) {
      assert.throws(() => execFileSync(process.execPath, [script, '--root', root, '--output', output], { stdio: 'pipe' }), /output must be/i);
    }
    await assert.rejects(access(join(root, 'github-upload')), { code: 'ENOENT' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('instrument data is mandatory and failure leaves no export', async () => {
  const root = await fixture();
  try {
    await rm(join(root, 'data/instruments.json'));
    assert.throws(() => execFileSync(process.execPath, [script, '--root', root], { stdio: 'pipe' }), /instruments\.json/);
    await assert.rejects(access(join(root, 'github-upload')), { code: 'ENOENT' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('only the four fixed root report summaries are exported when present', async () => {
  const root = await fixture();
  try {
    for (const name of [...summaries, 'latest-monthly.txt', 'latest-daily-2026-09-07.txt', 'private.txt', 'automation-state.json']) {
      await writeFile(join(root, 'reports', name), `summary: ${name}`);
    }
    await mkdir(join(root, 'reports/nested'));
    await writeFile(join(root, 'reports/nested/latest-daily.txt'), 'not a fixed summary');
    execFileSync(process.execPath, [script, '--root', root], { stdio: 'pipe' });
    const output = join(root, 'github-upload');
    assert.deepEqual((await filesAt(join(output, 'reports'))).filter(file => file.endsWith('.txt')), summaries.slice().sort());
    for (const name of summaries) assert.equal(await readFile(join(output, 'reports', name), 'utf8'), `summary: ${name}`);
    assert.deepEqual(await filesAt(join(output, 'data')), ['instruments.json']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('100 files are allowed including summaries, but 101 fail before copying', async () => {
  const root = await fixture();
  try {
    for (const name of summaries) await writeFile(join(root, 'reports', name), 'summary');
    for (let index = 0; index < 82; index++) await writeFile(join(root, `src/extra-${index}.ts`), 'export {};');
    execFileSync(process.execPath, [script, '--root', root], { stdio: 'pipe' });
    assert.equal((await filesAt(join(root, 'github-upload'))).length, 100);
    await writeFile(join(root, 'src/overflow.ts'), 'export {};');
    assert.throws(() => execFileSync(process.execPath, [script, '--root', root, '--output', 'github-upload-overflow'], { stdio: 'pipe' }), /101 files/);
    await assert.rejects(access(join(root, 'github-upload-overflow')), { code: 'ENOENT' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a file above 25 MiB is rejected before creating the export', async () => {
  const root = await fixture();
  try {
    await truncate(join(root, 'index.html'), 25 * 1024 * 1024 + 1);
    assert.throws(() => execFileSync(process.execPath, [script, '--root', root], { stdio: 'pipe' }), /25 MB/);
    await assert.rejects(access(join(root, 'github-upload')), { code: 'ENOENT' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('maintenance excludes snapshots and root delivery/cache copies but still enforces the project budget', async () => {
  const root = await fixture();
  try {
    await rm(join(root, '.cache/candles.sqlite'));
    const run = () => JSON.parse(execFileSync(process.execPath, ['--import', loader, maintenance], { cwd: root, encoding: 'utf8', stdio: 'pipe' }));
    const baseline = run();
    for (const directory of ['github-upload', 'github-upload-2026-09-07', 'github-uploadOther', '_site', '.cache', 'node_modules', 'node_modules - Copy']) {
      await mkdir(join(root, directory), { recursive: true });
      for (let index = 0; index < 101; index++) await writeFile(join(root, directory, `ignored-${index}.txt`), 'preserve');
    }
    const result = run();
    assert.equal(result.before, baseline.after);
    assert.equal(result.after, baseline.after);
    assert.deepEqual(result.errors, []);
    assert.equal(await readFile(join(root, 'github-upload-2026-09-07/ignored-0.txt'), 'utf8'), 'preserve');
    for (const directory of ['src/_site', 'src/.cache']) {
      await mkdir(join(root, directory), { recursive: true });
      await writeFile(join(root, directory, 'real-file.ts'), 'export {};');
    }
    assert.equal(run().after, baseline.after + 2);
    for (let index = 0; index < 101; index++) await writeFile(join(root, `src/real-${index}.ts`), 'export {};');
    assert.throws(run, error => {
      assert.equal((error as { status: number }).status, 1);
      assert.ok(JSON.parse((error as { stdout: string }).stdout).after > 100);
      return true;
    });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('current project paths plus 30 retained reports and all four summaries fit the upload budget', async context => {
  const root = await fixture();
  try {
    await rm(join(root, '.cache/candles.sqlite'));
    await rm(join(root, 'tests/example.test.ts'));
    const project = fileURLToPath(new URL('..', import.meta.url));
    const counts: Record<string, number> = {};
    for (const directory of ['src', 'tests', 'tools', '.github/workflows']) {
      const names = (await filesAt(join(project, directory))).filter(name => directory === '.github/workflows' ? /\.ya?ml$/.test(name) : directory === 'tools' ? /\.(?:mjs|ts)$/.test(name) : name.endsWith('.ts'));
      counts[directory] = names.length;
      for (const name of names) {
        await mkdir(join(root, directory, name, '..'), { recursive: true });
        await writeFile(join(root, directory, name), 'fixture');
      }
    }
    for (let day = 1; day <= 31; day++) await writeFile(join(root, 'reports', `report-daily-2026-08-${String(day).padStart(2, '0')}.html`), `report ${day}`);
    for (const name of summaries) await writeFile(join(root, 'reports', name), 'summary');
    const result = JSON.parse(execFileSync(process.execPath, ['--import', loader, maintenance], { cwd: root, encoding: 'utf8', stdio: 'pipe' }));
    assert.equal(result.archived, 2);
    assert.ok(result.after <= 100);
    execFileSync(process.execPath, [script, '--root', root, '--output', 'github-upload-steady-state'], { stdio: 'pipe' });
    const exported = await filesAt(join(root, 'github-upload-steady-state'));
    assert.equal(exported.filter(name => /^reports\/report-.*\.html$/.test(name)).length, 30);
    assert.equal(exported.filter(name => /^reports\/latest-.*\.txt$/.test(name)).length, 4);
    assert.ok(exported.length <= 100, `Steady-state upload exceeds 100 files: ${exported.length}`);
    context.diagnostic(JSON.stringify({ ...counts, root: 7, data: 1, state: 1, reports: 30, summaries: 4, total: exported.length }));
  } finally { await rm(root, { recursive: true, force: true }); }
});