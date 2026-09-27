const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash, randomBytes } = require('node:crypto');
const { readFile } = require('node:fs/promises');
const { join } = require('node:path');

test('SHA-256 navigateur identique à Node, même aux frontières de blocs', async () => {
  const source = await readFile(join(__dirname, '../public/sha256.js'), 'utf8');
  const { Sha256 } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  for (const size of [0, 1, 55, 56, 63, 64, 65, 1024, 4 * 1024 * 1024 + 5]) {
    const bytes = randomBytes(size);
    const hash = new Sha256();
    for (let offset = 0; offset < size; offset += 7777) hash.update(bytes.subarray(offset, offset + 7777));
    assert.equal(hash.hex(), createHash('sha256').update(bytes).digest('hex'), `taille ${size}`);
  }
});
