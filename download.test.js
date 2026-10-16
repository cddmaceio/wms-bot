const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { waitForDownload, downloadTimeout } = require('./download');

test('captures a download emitted during the click and removes the listener', async () => {
  const page = new EventEmitter();
  const download = { suggestedFilename: () => 'report.csv' };
  assert.equal(await waitForDownload(page, () => page.emit('download', download), 100), download);
  assert.equal(page.listenerCount('download'), 0);
});

test('waits for report generation after the click', async () => {
  const page = new EventEmitter();
  const download = {};
  const result = await waitForDownload(page, () => {
    setTimeout(() => page.emit('download', download), 15);
  }, 200);
  assert.equal(result, download);
  assert.equal(page.listenerCount('download'), 0);
});

test('times out and removes the listener when a control does not export', async () => {
  const page = new EventEmitter();
  await assert.rejects(waitForDownload(page, () => {}, 10), /Nenhum download iniciado/);
  assert.equal(page.listenerCount('download'), 0);
});

test('cleans up immediately on click failure without a later unhandled rejection', async () => {
  const page = new EventEmitter();
  await assert.rejects(waitForDownload(page, () => { throw new Error('click blocked'); }, 10), /click blocked/);
  assert.equal(page.listenerCount('download'), 0);
  await new Promise(resolve => setTimeout(resolve, 20));
});

test('uses a valid timeout and defaults invalid configuration to 60 seconds', () => {
  for (const value of [undefined, '', 'invalid', 'Infinity', '-1', '0']) {
    assert.equal(downloadTimeout(value), 60000);
  }
  assert.equal(downloadTimeout('120000'), 120000);
});
