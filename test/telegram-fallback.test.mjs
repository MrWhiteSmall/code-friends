import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Telegram } from '../src/telegram.mjs';
import { curlFetch } from '../src/telegram-curl.mjs';

const response = result => ({ json: async () => ({ ok: true, result }) });

test('native DOMException timeouts with numeric codes trigger fallback', async () => {
  const telegram = new Telegram('test', async () => { throw Object.freeze(new DOMException('timed out', 'TimeoutError')); }, {
    fallback: async () => response([]),
  });
  await assert.rejects(telegram.call('getUpdates'));
  await assert.rejects(telegram.call('getUpdates'));
  assert.equal(telegram.transport, 'curl');
  assert.deepEqual(await telegram.call('getUpdates'), []);
});

test('poll failures enable fallback even while sends work; native recovery is probed through one poll only', async () => {
  let online = false, now = 0;
  const fallbackCalls = [], changes = [];
  const telegram = new Telegram('test', async url => {
    if (url.endsWith('/getUpdates') && !online) throw new Error('timeout');
    return response([]);
  }, { now: () => now, onTransport: x => changes.push(x), fallback: async (url, options) => {
    fallbackCalls.push({ url, body: JSON.parse(options.body) });
    return response([]);
  } });
  await assert.rejects(telegram.call('getUpdates'));
  await telegram.call('sendMessage', { text: 'sent' });
  await assert.rejects(telegram.call('getUpdates'));
  assert.equal(telegram.transport, 'curl');
  await telegram.call('getUpdates', { offset: 17 });
  assert.deepEqual(fallbackCalls[0].body, { offset: 17 });
  now = 300000;
  await assert.rejects(telegram.call('getUpdates')); // Failed probe keeps fallback.
  assert.equal(telegram.transport, 'curl');
  online = true;
  await telegram.call('getUpdates');
  assert.equal(telegram.transport, 'curl'); // Wait for next probe window.
  now = 600000;
  await telegram.call('getUpdates');
  assert.equal(telegram.transport, 'fetch');
  assert.deepEqual(changes.map(x => x.transport), ['curl', 'fetch']);
});

test('a failed mutation is never replayed through fallback and fatal/rate-limit errors do not switch transports', async () => {
  let nativeCalls = 0, fallbackCalls = 0;
  const telegram = new Telegram('test', async () => { nativeCalls++; throw new Error('offline'); }, {
    fallback: async () => { fallbackCalls++; return response({ message_id: 2 }); },
  });
  await assert.rejects(telegram.call('sendMessage', { text: 'first' }));
  await assert.rejects(telegram.call('sendMessage', { text: 'second' }));
  assert.equal(nativeCalls, 2);
  assert.equal(fallbackCalls, 0);
  await telegram.call('sendMessage', { text: 'third' });
  assert.equal(fallbackCalls, 1);
  for (const code of [400, 401, 409, 429]) {
    const api = new Telegram('test', async () => ({ json: async () => ({ ok: false, error_code: code }) }));
    await assert.rejects(api.call('getUpdates'));
    await assert.rejects(api.call('getUpdates'));
    assert.equal(api.transport, 'fetch');
  }
});

test('curl passes escaped credentials and payload only through stdin, preserves API errors and redacts process errors', async t => {
  const root = await mkdtemp(join(tmpdir(), 'cf-curl-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const executable = join(root, 'curl');
  const capture = join(root, 'capture.json');
  const token = '123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi';
  await writeFile(executable, `#!${process.execPath}
import { writeFileSync } from 'node:fs';
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', x => input += x);
process.stdin.on('end', () => {
  writeFileSync(${JSON.stringify(capture)}, JSON.stringify({ argv: process.argv.slice(2), input }));
  console.log(JSON.stringify({ ok: false, error_code: 429, description: 'rate limited', parameters: { retry_after: 3 } }));
});
`, { mode: 0o700 });
  const fallback = (url, options) => curlFetch(url, options, { executable });
  const telegram = new Telegram(token, async () => { throw new Error('offline'); }, { fallback });
  await assert.rejects(telegram.call('getMe'));
  await assert.rejects(telegram.call('getMe'));
  const text = '引号 " \\ 换行\n不执行 $(touch /tmp/no) `id`';
  await assert.rejects(telegram.call('sendMessage', { text }), e => e.code === 429 && e.retryAfter === 3);
  const record = JSON.parse(await readFile(capture, 'utf8'));
  assert.deepEqual(record.argv, ['--disable', '--config', '-']);
  assert.ok(!record.argv.join(' ').includes(token));
  const unquote = value => value.slice(1, -1).replace(/\\([\\"rnt])/g, (_, x) => ({ r: '\r', n: '\n', t: '\t' }[x] ?? x));
  const line = record.input.split('\n').find(x => x.startsWith('data-binary = '));
  assert.deepEqual(JSON.parse(unquote(line.slice('data-binary = '.length))), { text });
  assert.ok(record.input.includes('/bot' + token + '/sendMessage'));
  await writeFile(executable, `#!${process.execPath}\nprocess.stderr.write(${JSON.stringify(token)}); process.exit(7);\n`, { mode: 0o700 });
  await assert.rejects(telegram.call('getMe'), e => !e.message.includes(token) && !e.cause);
});

test('curl terminates a hung child when the request aborts', async t => {
  const root = await mkdtemp(join(tmpdir(), 'cf-curl-abort-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const executable = join(root, 'curl');
  await writeFile(executable, `#!${process.execPath}\nsetInterval(() => {}, 1000);\n`, { mode: 0o700 });
  const controller = new AbortController();
  const call = curlFetch('https://example.invalid/', { body: '{}', signal: controller.signal }, { executable });
  controller.abort();
  await assert.rejects(call, /aborted or timed out/);
});
