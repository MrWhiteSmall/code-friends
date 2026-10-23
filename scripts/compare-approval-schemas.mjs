import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const output = fileURLToPath(new URL('../.local/approval-investigation/', import.meta.url));
mkdirSync(output, { recursive: true, mode: 0o700 });
const versions = process.argv.slice(2);
for (const version of versions.length ? versions : ['0.162.1', '0.164.0']) {
  if (!/^0\.\d+\.\d+$/.test(version)) throw new Error('Expected an exact local version');
  const executable = `/Users/lsj/.codex/packages/app-server-daemon/releases/${version}-aarch64-apple-darwin/bin/codex`;
  const directory = join(output, `schema-${version}`);
  const env = { ...process.env };
  delete env.TELEGRAM_TOKEN;
  const binaryVersion = execFileSync(executable, ['--version'], { env, encoding: 'utf8' }).trim();
  execFileSync(executable, ['app-server', 'generate-ts', '--experimental', '--out', directory], { env, timeout: 30000 });
  const selected = {};
  function scan(path) {
    for (const item of readdirSync(path, { withFileTypes: true })) {
      const file = join(path, item.name);
      if (item.isDirectory()) scan(file);
      else if (/^(?:ServerRequest|.*(?:Approval|Permission|Elicitation).*)\.ts$/.test(item.name)) {
        selected[file.slice(directory.length + 1)] = readFileSync(file, 'utf8');
      }
    }
  }
  scan(directory);
  const report = { version: binaryVersion, executable, files: selected };
  writeFileSync(join(output, `schema-${version}.json`), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ version: binaryVersion, selectedFiles: Object.keys(selected) }));
}
