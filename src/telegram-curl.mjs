import { spawn } from 'node:child_process';

// curl config quoting is not shell quoting. Credentials and payload travel only
// over stdin, never argv, temporary files or a shell command.
const quote = value => '"' + String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  .replace(/\r/g, '\\r').replace(/\n/g, '\\n').replace(/\t/g, '\\t') + '"';

export function curlFetch(url, options, { executable = '/usr/bin/curl' } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['--disable', '--config', '-'], { stdio: ['pipe', 'pipe', 'pipe'] });
    const config = [
      `url = ${quote(url)}`, 'request = "POST"', 'header = "Content-Type: application/json"',
      `data-binary = ${quote(options.body)}`, 'silent', 'show-error',
      'connect-timeout = 5', 'max-time = 20', 'proto = "=https"',
    ].join('\n') + '\n';
    let output = '';
    let failed = false;
    const fail = message => {
      if (failed) return;
      failed = true;
      child.kill('SIGKILL');
      reject(new Error(message));
    };
    const abort = () => fail('curl request aborted or timed out');
    // A fresh process/tunnel for each request avoids reusing a proxy connection
    // tied to an old Clash node. Inherit the user's proxy environment unchanged.
    const timer = setTimeout(() => fail('curl process timed out'), 22000);
    child.on('error', () => fail('curl could not start'));
    child.stdin.on('error', () => fail('curl input failed'));
    child.stderr.resume(); // curl errors can contain the URL/token; never log them.
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      output += chunk;
      if (Buffer.byteLength(output) > 8 * 1024 * 1024) fail('curl response exceeded size limit');
    });
    child.on('close', code => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      if (failed) return;
      if (code !== 0) return reject(new Error(`curl transport failed (exit ${code})`));
      resolve({ json: async () => JSON.parse(output) });
    });
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    else child.stdin.end(config);
  });
}
