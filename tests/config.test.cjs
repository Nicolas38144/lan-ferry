const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig } = require('../dist/services/config.js');

test('new configuration keys work and previous keys remain supported', () => {
  const names = ['FILE_TRANSFER_CONCURRENCY', 'PHOTO_TRANSFER_CONCURRENCY'];
  const previous = names.map((name) => process.env[name]);
  try {
    process.env.FILE_TRANSFER_CONCURRENCY = '3';
    process.env.PHOTO_TRANSFER_CONCURRENCY = '4';
    assert.equal(loadConfig().concurrency, 3);
    delete process.env.FILE_TRANSFER_CONCURRENCY;
    assert.equal(loadConfig().concurrency, 4);
  } finally {
    names.forEach((name, index) => {
      if (previous[index] === undefined) delete process.env[name];
      else process.env[name] = previous[index];
    });
  }
});
