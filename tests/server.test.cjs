const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash, randomBytes } = require('node:crypto');
const { mkdtemp, readFile, readdir, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { createServer } = require('../dist/server/server.js');
const { transferStateDirectory } = require('../dist/services/resumable-storage.js');

const hash = (data) => createHash('sha256').update(data).digest('hex');
function multipart(data, filename = 'photo.jpg') {
  const boundary = 'photo-transfer-test-boundary';
  return {
    boundary,
    body: Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`),
      data,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
  };
}

test('HTTP : session requise, upload vérifié, collision et rejet SHA-256', async () => {
  const destination = await mkdtemp(join(tmpdir(), 'photo-transfer-api-'));
  const { server, auth } = await createServer({ port: 8080, host: '127.0.0.1', destination, concurrency: 2, auth: true });
  try {
    const data = Buffer.from([0, 255, 1, 2, 3, 128]);
    const { body, boundary } = multipart(data);
    const headers = {
      'content-type': `multipart/form-data; boundary=${boundary}`,
      'x-file-name': encodeURIComponent('photo été.jpg'),
      'x-file-size': String(data.length),
      'x-file-mime': 'image/jpeg',
      'x-file-sha256': hash(data),
    };
    const unauthorized = await server.inject({ method: 'POST', url: '/api/upload', headers, payload: body });
    assert.equal(unauthorized.statusCode, 401);
    const landing = await server.inject({ method: 'GET', url: `/?token=${auth.token}` });
    assert.equal(landing.statusCode, 200);
    assert.equal(landing.headers.location, undefined);
    assert.match(landing.body, /Fichiers sélectionnés/);
    assert.match(landing.headers['set-cookie'], /SameSite=Lax/);
    const cookie = landing.headers['set-cookie'].split(';')[0];
    const sessionPage = await server.inject({ method: 'GET', url: '/', headers: { cookie } });
    assert.equal(sessionPage.statusCode, 200);
    const withoutSession = await server.inject({ method: 'GET', url: '/' });
    assert.equal(withoutSession.statusCode, 401);
    for (const expectedName of ['photo été.jpg', 'photo été_1.jpg']) {
      const response = await server.inject({ method: 'POST', url: '/api/upload', headers: { ...headers, cookie }, payload: body });
      assert.equal(response.statusCode, 201, response.body);
      assert.equal(response.json().file.savedAs, expectedName);
      assert.equal(hash(await readFile(join(destination, expectedName))), hash(data));
    }
    const bad = await server.inject({ method: 'POST', url: '/api/upload', headers: { ...headers, cookie, 'x-file-sha256': '0'.repeat(64) }, payload: body });
    assert.equal(bad.statusCode, 400);
    assert.deepEqual((await readdir(destination)).sort(), ['photo été.jpg', 'photo été_1.jpg']);
    const files = await server.inject({ method: 'GET', url: '/api/files', headers: { cookie } });
    assert.equal(files.json().files.length, 2);
    const admin = await server.inject({ method: 'GET', url: '/admin' });
    assert.equal(admin.statusCode, 200);
    assert.match(admin.body, /<svg/);
    const large = randomBytes(128 * 1024);
    const largePart = multipart(large, 'large.bin');
    const largeResponse = await server.inject({
      method: 'POST', url: '/api/upload',
      headers: { ...headers, cookie, 'content-type': `multipart/form-data; boundary=${largePart.boundary}`, 'x-file-name': 'large.bin', 'x-file-size': String(large.length), 'x-file-sha256': hash(large) },
      payload: largePart.body,
    });
    assert.equal(largeResponse.statusCode, 201, largeResponse.body);
    assert.equal(hash(await readFile(join(destination, 'large.bin'))), hash(large));
    for (const [name, mime] of [
      ['notes.txt', 'text/plain'],
      ['archive.zip', 'application/zip'],
      ['report.pdf', 'application/pdf'],
      ['song.mp3', 'audio/mpeg'],
      ['unknown-format', 'application/octet-stream'],
    ]) {
      const contents = Buffer.from(`File data: ${name}\0\xff`, 'utf8');
      const sample = multipart(contents, name);
      const response = await server.inject({
        method: 'POST', url: '/api/upload',
        headers: {
          ...headers, cookie,
          'content-type': `multipart/form-data; boundary=${sample.boundary}`,
          'x-file-name': encodeURIComponent(name),
          'x-file-size': String(contents.length),
          'x-file-mime': mime,
          'x-file-sha256': hash(contents),
        },
        payload: sample.body,
      });
      assert.equal(response.statusCode, 201, `${name}: ${response.body}`);
      assert.deepEqual(await readFile(join(destination, name)), contents);
      assert.equal(response.json().file.mime, mime);
    }
  } finally { await server.close(); await rm(destination, { recursive: true, force: true }); await rm(transferStateDirectory(destination), { recursive: true, force: true }); }
});
