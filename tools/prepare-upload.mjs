import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, readFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { parseArgs, isDeepStrictEqual } from 'node:util';
import { DatabaseSync } from 'node:sqlite';

const { values } = parseArgs({ options: { root: { type: 'string', default: process.cwd() } } });
const root = resolve(values.root);
const destination = join(root, 'github-upload');
const maxFiles = 100;
const maxBytes = 25 * 1024 * 1024;
const files = ['package.json', 'package-lock.json', 'tsconfig.json', 'README.md', 'index.html', '.gitignore', '.gitattributes'];

async function collect(directory, allowed) {
  const location = join(root, directory);
  if (!(await lstat(location)).isDirectory()) throw new Error(`Expected directory: ${directory}`);
  for (const entry of await readdir(location, { withFileTypes: true })) {
    const relative = `${directory}/${entry.name}`;
    if (entry.isSymbolicLink()) throw new Error(`Upload cannot contain a symbolic link: ${relative}`);
    if (entry.isDirectory()) await collect(relative, allowed);
    else if (entry.isFile() && allowed(entry.name)) files.push(relative);
  }
}

await collect('.github/workflows', name => /\.ya?ml$/.test(name));
await collect('src', name => name.endsWith('.ts'));
await collect('tests', name => name.endsWith('.ts'));
await collect('tools', name => /\.(?:mjs|ts)$/.test(name));
await collect('reports', name => /^(?:report-(?:daily|weekly)|backtest)-\d{4}-\d{2}-\d{2}\.html$/.test(name) || name === 'state.sqlite');

for (const required of ['.github/workflows/reports.yml', 'src/index.ts', 'tools/report-summary.mjs', 'reports/state.sqlite']) {
  if (!files.includes(required)) throw new Error(`Required upload file is missing: ${required}`);
}
if (files.length > maxFiles) throw new Error(`Upload has ${files.length} files; maximum is ${maxFiles}. Run npm run storage:maintain first.`);
for (const relative of files) {
  const info = await lstat(join(root, relative));
  if (!info.isFile()) throw new Error(`Expected regular file: ${relative}`);
  if (info.size > maxBytes) throw new Error(`File exceeds GitHub's 25 MB browser limit: ${relative}`);
}
try { await mkdir(destination); }
catch (error) {
  if (error.code === 'EEXIST') throw new Error('github-upload already exists; move it elsewhere before preparing a new upload. No files were overwritten.');
  throw error;
}

const hashes = new Map();
let totalBytes = 0;
let largest = { file: '', bytes: 0 };
for (const relative of files.sort()) {
  const source = join(root, relative);
  const target = join(destination, relative);
  await mkdir(dirname(target), { recursive: true });
  if (relative === 'reports/state.sqlite') {
    const database = new DatabaseSync(source, { readOnly: true });
    try {
      database.exec('BEGIN');
      const records = database.prepare('SELECT key, value FROM documents ORDER BY key').all();
      database.exec('COMMIT');
      database.prepare('VACUUM INTO ?').run(target);
      const snapshot = new DatabaseSync(target, { readOnly: true });
      try {
        if (Object.values(snapshot.prepare('PRAGMA integrity_check').get())[0] !== 'ok') throw new Error('History snapshot failed integrity check');
        if (!isDeepStrictEqual(snapshot.prepare('SELECT key, value FROM documents ORDER BY key').all(), records)) {
          throw new Error('History changed during export; upload was not verified. Prepare a new folder after report generation finishes.');
        }
      } finally { snapshot.close(); }
    } finally { database.close(); }
  } else {
    const original = await readFile(source);
    await copyFile(source, target, constants.COPYFILE_EXCL);
    hashes.set(relative, createHash('sha256').update(original).digest('hex'));
  }
  const content = await readFile(target);
  if (content.length > maxBytes) throw new Error(`Exported file exceeds 25 MB: ${relative}`);
  if (hashes.has(relative) && hashes.get(relative) !== createHash('sha256').update(content).digest('hex')) {
    throw new Error(`File changed during export: ${relative}`);
  }
  totalBytes += content.length;
  if (content.length > largest.bytes) largest = { file: relative, bytes: content.length };
}

console.log(JSON.stringify({ directory: destination, files: files.length, limit: maxFiles, totalBytes, largest, verified: true }, null, 2));
console.log('Upload the CONTENTS of github-upload to the repository root, including .github, .gitignore and .gitattributes. Do not upload the parent folder.');