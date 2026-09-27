const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash, randomBytes } = require('node:crypto');
const { readFile } = require('node:fs/promises');
const { join } = require('node:path');

test('browser worker hashes whole files and each upload chunk', async () => {
  const shaSource = await readFile(join(__dirname, '../public/sha256.js'), 'utf8');
  const shaUrl = `data:text/javascript;base64,${Buffer.from(shaSource).toString('base64')}`;
  const workerSource = (await readFile(join(__dirname, '../public/hash-worker.js'), 'utf8'))
    .replace("'./sha256.js'", `'${shaUrl}'`);
  const messages = [];
  const previous = globalThis.self;
  globalThis.self = { postMessage: (message) => messages.push(message) };
  try {
    await import(`data:text/javascript;base64,${Buffer.from(workerSource).toString('base64')}`);
    const bytes = randomBytes(4 * 1024 * 1024 + 17);
    await globalThis.self.onmessage({ data: { file: new Blob([bytes]), chunkSize: 4 * 1024 * 1024 } });
    const result = messages.at(-1);
    assert.equal(result.type, 'done');
    assert.equal(result.sha256, createHash('sha256').update(bytes).digest('hex'));
    assert.deepEqual(result.chunks, [
      createHash('sha256').update(bytes.subarray(0, 4 * 1024 * 1024)).digest('hex'),
      createHash('sha256').update(bytes.subarray(4 * 1024 * 1024)).digest('hex'),
    ]);
    assert.equal(messages.filter((message) => message.type === 'progress').length, 2);
    messages.length = 0;
    await globalThis.self.onmessage({ data: { file: new Blob([]), chunkSize: 4 * 1024 * 1024 } });
    assert.equal(messages.at(-1).sha256, createHash('sha256').update(Buffer.alloc(0)).digest('hex'));
  } finally { globalThis.self = previous; }
});
