const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

test('configuration uses the optional project .env and respects environment overrides', (t) => {
  const cwd = mkdtempSync(join(tmpdir(), 'file-transfer-config-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const project = join(cwd, 'project');
  const configDirectory = join(project, 'dist', 'services');
  mkdirSync(configDirectory, { recursive: true });
  const configPath = join(configDirectory, 'config.js');
  copyFileSync(require.resolve('../dist/services/config.js'), configPath);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(FILE|PHOTO)_TRANSFER_/i.test(key)));
  const loadConfig = (overrides) => JSON.parse(execFileSync(process.execPath, [
    '-e', 'console.log(JSON.stringify(require(process.argv[1]).loadConfig()))', configPath,
  ], { cwd, encoding: 'utf8', env: { ...env, ...overrides } }));

  assert.equal(loadConfig().destination, join(project, 'output'));
  writeFileSync(join(project, '.env'), 'FILE_TRANSFER_PORT=9090\nFILE_TRANSFER_DESTINATION="my photos"\n');
  const config = loadConfig({ FILE_TRANSFER_PORT: '9091' });
  assert.equal(config.port, 9091);
  assert.equal(config.destination, join(cwd, 'my photos'));
  assert.equal(loadConfig().port, 9090);
  assert.equal(loadConfig({ FILE_TRANSFER_CONCURRENCY: '3', PHOTO_TRANSFER_CONCURRENCY: '4' }).concurrency, 3);
  assert.equal(loadConfig({ PHOTO_TRANSFER_CONCURRENCY: '4' }).concurrency, 4);
});
