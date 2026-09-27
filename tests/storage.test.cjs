const test = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes, createHash } = require('node:crypto');
const { mkdtemp, readFile, readdir, stat, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { Readable } = require('node:stream');
const { storeFile } = require('../dist/services/file-storage.js');
const { safeFilename } = require('../dist/utils/filename.js');

const digest = (data) => createHash('sha256').update(data).digest('hex');
async function withDirectory(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'photo-transfer-test-'));
  try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}
function meta(name, data) { return { name, size: data.length, mime: 'application/octet-stream', sha256: digest(data) }; }

test('octets identiques, fichier volumineux et date restaurée', async () => withDirectory(async (dir) => {
  const bytes = randomBytes(16 * 1024 * 1024 + 17);
  const m = { ...meta('été ☀ photo.raw', bytes), lastModified: Date.UTC(2020, 1, 3) };
  const saved = await storeFile(dir, Readable.from([bytes.subarray(0, 4_000_000), bytes.subarray(4_000_000)]), m);
  const target = await readFile(join(dir, saved.savedAs));
  assert.equal(target.length, bytes.length);
  assert.equal(digest(target), digest(bytes));
  assert.deepEqual(target, bytes);
  assert.ok(Math.abs((await stat(join(dir, saved.savedAs))).mtimeMs - m.lastModified) < 2000);
}));

test('fichiers vides, espaces, accents et collisions sans écrasement', async () => withDirectory(async (dir) => {
  const empty = Buffer.alloc(0);
  const first = await storeFile(dir, Readable.from([]), meta('IMG été.jpg', empty));
  const second = await storeFile(dir, Readable.from([]), meta('IMG été.jpg', empty));
  assert.equal(first.savedAs, 'IMG été.jpg');
  assert.equal(second.savedAs, 'IMG été_1.jpg');
  assert.equal((await readFile(join(dir, second.savedAs))).length, 0);
}));

test('traversée de chemins Windows et Unix neutralisée', async () => withDirectory(async (dir) => {
  for (const name of ['../file.jpg', '../../test.jpg', '..\\..\\Windows\\secret.jpg', 'C:\\x\\photo.jpg']) {
    const data = Buffer.from(name);
    const saved = await storeFile(dir, Readable.from([data]), meta(name, data));
    assert.ok(!saved.savedAs.includes('/') && !saved.savedAs.includes('\\'));
    assert.deepEqual(await readFile(join(dir, saved.savedAs)), data);
  }
  assert.equal(safeFilename('CON.jpg'), '_CON.jpg');
}));

test('checksum et taille incorrects suppriment le fichier temporaire', async () => withDirectory(async (dir) => {
  const bytes = randomBytes(1024);
  await assert.rejects(storeFile(dir, Readable.from([bytes]), { ...meta('bad.jpg', bytes), sha256: '0'.repeat(64) }), /SHA-256/);
  await assert.rejects(storeFile(dir, Readable.from([bytes]), { ...meta('short.jpg', bytes), size: bytes.length + 1 }), /taille/);
  assert.deepEqual(await readdir(dir), []);
}));
