const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash, randomBytes } = require('node:crypto');
const { appendFile, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { createServer } = require('../dist/server/server.js');
const { CHUNK_BYTES, PARTIAL_RETENTION_MS, ResumableStorage, transferStateDirectory } = require('../dist/services/resumable-storage.js');

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const config = (destination) => ({ port: 8080, host: '127.0.0.1', destination, concurrency: 2, auth: true });
const cleanup = async (destination) => { await rm(destination, { recursive: true, force: true }); await rm(transferStateDirectory(destination), { recursive: true, force: true }); };

function form(bytes) {
  const boundary = 'resumable-test-boundary';
  return {
    boundary,
    payload: Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="chunk"; filename="chunk.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`),
      bytes,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
  };
}

async function cookie(server, auth) {
  const response = await server.inject({ method: 'GET', url: `/?token=${auth.token}` });
  assert.equal(response.statusCode, 200);
  return response.headers['set-cookie'].split(';')[0];
}

async function chunk(server, session, cookieValue, offset, bytes, checksum = sha(bytes), advertisedLength = bytes.length) {
  const body = form(bytes);
  return server.inject({
    method: 'POST', url: `/api/uploads/${session.id}/chunk`,
    headers: {
      cookie: cookieValue,
      'content-type': `multipart/form-data; boundary=${body.boundary}`,
      'x-upload-offset': String(offset),
      'x-chunk-size': String(advertisedLength),
      'x-chunk-sha256': checksum,
    },
    payload: body.payload,
  });
}

test('chunked upload resumes after server restart and publishes only verified bytes', async () => {
  const destination = await mkdtemp(join(tmpdir(), 'file-transfer-resume-'));
  const stateDirectory = transferStateDirectory(destination);
  const source = randomBytes(CHUNK_BYTES + 41);
  let instance = await createServer(config(destination));
  try {
    let sessionCookie = await cookie(instance.server, instance.auth);
    const metadata = { name: 'backup.zip', size: source.length, mime: 'application/zip', sha256: sha(source) };
    const unauthorized = await instance.server.inject({ method: 'POST', url: '/api/uploads', headers: { 'content-type': 'application/json' }, payload: JSON.stringify(metadata) });
    assert.equal(unauthorized.statusCode, 401);
    const created = await instance.server.inject({ method: 'POST', url: '/api/uploads', headers: { cookie: sessionCookie, 'content-type': 'application/json' }, payload: JSON.stringify(metadata) });
    assert.equal(created.statusCode, 201, created.body);
    const session = created.json();
    const first = source.subarray(0, CHUNK_BYTES);
    const bad = await chunk(instance.server, session, sessionCookie, 0, first, '0'.repeat(64));
    assert.equal(bad.statusCode, 400, bad.body);
    assert.equal((await stat(join(stateDirectory, `.transfer-${session.id}.part`))).size, 0);
    const interrupted = await chunk(instance.server, session, sessionCookie, 0, first.subarray(0, 1024), sha(first), first.length);
    assert.equal(interrupted.statusCode, 400, interrupted.body);
    assert.equal((await stat(join(stateDirectory, `.transfer-${session.id}.part`))).size, 0);
    const incomplete = await instance.server.inject({ method: 'POST', url: `/api/uploads/${session.id}/complete`, headers: { cookie: sessionCookie } });
    assert.equal(incomplete.statusCode, 409);
    const accepted = await chunk(instance.server, session, sessionCookie, 0, first);
    assert.equal(accepted.statusCode, 200, accepted.body);
    assert.equal(accepted.json().offset, CHUNK_BYTES);
    const stale = await chunk(instance.server, session, sessionCookie, 0, first);
    assert.equal(stale.statusCode, 409, stale.body);
    await appendFile(join(stateDirectory, `.transfer-${session.id}.part`), Buffer.from('unconfirmed tail'));
    await rename(join(stateDirectory, `.transfer-${session.id}.part`), join(destination, `.transfer-${session.id}.part`));
    await rename(join(stateDirectory, `.transfer-${session.id}.json`), join(destination, `.transfer-${session.id}.json`));
    await instance.server.close();

    instance = await createServer(config(destination));
    sessionCookie = await cookie(instance.server, instance.auth);
    const status = await instance.server.inject({ method: 'GET', url: `/api/uploads/${session.id}`, headers: { cookie: sessionCookie } });
    assert.equal(status.statusCode, 200);
    assert.equal(status.json().offset, CHUNK_BYTES);
    assert.equal((await stat(join(stateDirectory, `.transfer-${session.id}.part`))).size, CHUNK_BYTES);
    assert.deepEqual(await readdir(destination), []);
    const tail = source.subarray(CHUNK_BYTES);
    const resumed = await chunk(instance.server, session, sessionCookie, CHUNK_BYTES, tail);
    assert.equal(resumed.statusCode, 200, resumed.body);
    const completed = await instance.server.inject({ method: 'POST', url: `/api/uploads/${session.id}/complete`, headers: { cookie: sessionCookie } });
    assert.equal(completed.statusCode, 200, completed.body);
    assert.equal(completed.json().file.savedAs, 'backup.zip');
    assert.equal(sha(await readFile(join(destination, 'backup.zip'))), sha(source));
    assert.deepEqual(await readdir(destination), ['backup.zip']);
    const repeated = await instance.server.inject({ method: 'POST', url: `/api/uploads/${session.id}/complete`, headers: { cookie: sessionCookie } });
    assert.equal(repeated.statusCode, 200);
    assert.deepEqual(await readdir(stateDirectory), []);
    await writeFile(join(destination, `.transfer-${session.id}.done.json`), JSON.stringify({ file: completed.json().file, completedAt: Date.now() }));
    await instance.server.close();

    instance = await createServer(config(destination));
    sessionCookie = await cookie(instance.server, instance.auth);
    const receipt = await instance.server.inject({ method: 'GET', url: `/api/uploads/${session.id}`, headers: { cookie: sessionCookie } });
    assert.equal(receipt.statusCode, 404);
    assert.deepEqual(await readdir(destination), ['backup.zip']);
    assert.deepEqual(await readdir(stateDirectory), []);
  } finally { await instance.server.close(); await cleanup(destination); }
});

test('final checksum mismatch removes the partial file; empty files are valid', async () => {
  const destination = await mkdtemp(join(tmpdir(), 'file-transfer-final-hash-'));
  const { server, auth } = await createServer(config(destination));
  try {
    const sessionCookie = await cookie(server, auth);
    const data = Buffer.from('opaque contents');
    const badSession = await server.inject({
      method: 'POST', url: '/api/uploads',
      headers: { cookie: sessionCookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ name: 'wrong.bin', size: data.length, mime: 'application/octet-stream', sha256: '0'.repeat(64) }),
    });
    const badId = badSession.json().id;
    assert.equal((await chunk(server, { id: badId }, sessionCookie, 0, data)).statusCode, 200);
    const rejected = await server.inject({ method: 'POST', url: `/api/uploads/${badId}/complete`, headers: { cookie: sessionCookie } });
    assert.equal(rejected.statusCode, 422, rejected.body);
    assert.deepEqual((await readdir(destination)).filter((name) => name.includes(badId)), []);
    assert.equal((await readdir(destination)).includes('wrong.bin'), false);
    const emptySession = await server.inject({
      method: 'POST', url: '/api/uploads',
      headers: { cookie: sessionCookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ name: 'empty.txt', size: 0, mime: 'text/plain', sha256: sha(Buffer.alloc(0)) }),
    });
    const emptyId = emptySession.json().id;
    const completed = await server.inject({ method: 'POST', url: `/api/uploads/${emptyId}/complete`, headers: { cookie: sessionCookie } });
    assert.equal(completed.statusCode, 200, completed.body);
    assert.equal((await stat(join(destination, 'empty.txt'))).size, 0);
  } finally { await server.close(); await cleanup(destination); }
});

test('disk preflight rejects a file larger than available space', async () => {
  const destination = await mkdtemp(join(tmpdir(), 'file-transfer-space-'));
  const { server, auth } = await createServer(config(destination));
  try {
    const sessionCookie = await cookie(server, auth);
    const response = await server.inject({
      method: 'POST', url: '/api/uploads',
      headers: { cookie: sessionCookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ name: 'huge.bin', size: Number.MAX_SAFE_INTEGER, mime: 'application/octet-stream', sha256: sha(Buffer.alloc(0)) }),
    });
    assert.equal(response.statusCode, 507, response.body);
  } finally { await server.close(); await cleanup(destination); }
});

test('expired partial transfers are removed at startup', async () => {
  const destination = await mkdtemp(join(tmpdir(), 'file-transfer-cleanup-'));
  try {
    const first = new ResumableStorage(destination, 2);
    await first.initialize();
    const session = await first.create({ name: 'old.bin', size: 10, mime: 'application/octet-stream', sha256: sha(Buffer.alloc(10)) });
    const manifestPath = join(transferStateDirectory(destination), `.transfer-${session.id}.json`);
    const metadata = JSON.parse(await readFile(manifestPath, 'utf8'));
    metadata.updatedAt = Date.now() - PARTIAL_RETENTION_MS - 1000;
    await writeFile(manifestPath, JSON.stringify(metadata));
    const second = new ResumableStorage(destination, 2);
    await second.initialize();
    assert.throws(() => second.status(session.id), /expiré/);
    assert.deepEqual((await readdir(destination)).filter((name) => name.includes(session.id)), []);
  } finally { await cleanup(destination); }
});
