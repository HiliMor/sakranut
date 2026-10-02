import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, chmodSync, symlinkSync, readlinkSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';

const installer = readFileSync(new URL('../ops/wiki-interest/install.sh', import.meta.url), 'utf8');
const bash = process.env.WIKI_INTEREST_TEST_BASH || 'bash';
const bashSupportsAssociativeArrays = spawnSync(bash, ['-c', 'declare -A probe'], { encoding: 'utf8' }).status === 0;
const units = ['wiki-interest-collect.service', 'wiki-interest-collect.timer', 'wiki-interest-health.service', 'wiki-interest-health.timer'];
const releaseId = '20261002T120000Z-rollbacktest';

// Every privileged operation is replaced by a filesystem-only stub. The copy
// under test uses a fresh temp tree, never /etc, /opt or the real service manager.
const mockTool = `#!${process.execPath}
import { appendFileSync, mkdirSync, copyFileSync, renameSync } from 'node:fs';
import { basename, dirname } from 'node:path';
const command = basename(process.argv[1]);
const args = process.argv.slice(2);
appendFileSync(process.env.MOCK_LOG, JSON.stringify([command, ...args]) + '\\n');
if (command === 'systemctl') {
  if (args[0] === 'is-enabled' || args[0] === 'is-active') {
    if (process.env.MOCK_PRIOR === 'yes') console.log(args[0] === 'is-enabled' ? 'enabled' : 'active');
    else process.exit(4);
  }
  if (process.env.MOCK_FAILURE === 'collector' && args[0] === 'start' && args[1] === 'wiki-interest-collect.service') process.exit(17);
} else if (command === 'curl') {
  if (process.env.MOCK_FAILURE === 'smoke') process.exit(22);
} else if (command === 'install') {
  let directories = false;
  const paths = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-d') directories = true;
    else if (['-o', '-g', '-m'].includes(args[i])) i++;
    else paths.push(args[i]);
  }
  if (directories) for (const path of paths) mkdirSync(path, { recursive: true });
  else { mkdirSync(dirname(paths[1]), { recursive: true }); copyFileSync(paths[0], paths[1]); }
} else if (command === 'mv') {
  const paths = args.filter(arg => !arg.startsWith('-'));
  renameSync(paths[0], paths[1]);
}
`;

for (const prior of [false, true]) {
  for (const failure of ['collector', 'smoke']) {
    test(`private installer restores ${prior ? 'prior release and config' : 'first-install absence'} after ${failure} failure`, {
      skip: !bashSupportsAssociativeArrays && 'Installer requires Bash 4+; run this isolated test on Linux',
    }, () => {
      const root = mkdtempSync(join(tmpdir(), 'wiki-interest-ops-test-'));
      try {
        const put = (path, content) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content); };
        const bundle = join(root, 'bundle');
        const bin = join(root, 'bin');
        mkdirSync(bin);
        put(join(root, 'package.json'), '{"type":"module"}');
        put(join(bin, 'mock-tool'), mockTool);
        chmodSync(join(bin, 'mock-tool'), 0o755);
        for (const command of ['flock', 'nginx', 'node', 'systemd-analyze', 'getent', 'useradd', 'install', 'chown', 'chmod', 'systemctl', 'curl', 'mv']) symlinkSync('mock-tool', join(bin, command));
        for (const name of ['package.json', 'collect.mjs', 'data-lib.mjs', 'runtime-lib.mjs', 'run-daily.mjs', 'health.mjs', 'src/ui-lib.js', 'site/index.html']) put(join(bundle, 'app', name), 'new app');
        put(join(bundle, 'ops/nginx-private.conf'), 'new private configuration');
        for (const unit of units) put(join(bundle, 'ops', unit), `new ${unit}`);
        const appRoot = join(root, 'opt/wiki-interest');
        const config = join(root, 'etc/nginx/sites-enabled/wiki-interest-private.conf');
        const unitRoot = join(root, 'etc/systemd/system');
        mkdirSync(unitRoot, { recursive: true });
        if (prior) {
          mkdirSync(join(appRoot, 'releases/old'), { recursive: true });
          symlinkSync('releases/old', join(appRoot, 'current'));
          put(config, 'previous private configuration');
          for (const unit of units) put(join(unitRoot, unit), `previous ${unit}`);
        }
        let sandboxed = installer.replace('if [[ "${EUID}" -ne 0 || $# -ne 2 ]]; then', 'if [[ $# -ne 2 ]]; then');
        assert.notEqual(sandboxed, installer, 'Only test copy bypasses root requirement');
        for (const path of ['/opt/wiki-interest', '/var/lib/wiki-interest', '/etc/wiki-interest', '/var/backups/wiki-interest-config', '/etc/nginx/sites-enabled/wiki-interest-private.conf', '/etc/systemd/system']) sandboxed = sandboxed.replaceAll(path, join(root, path));
        sandboxed = sandboxed.replace('export PATH=/usr/local/bin:/usr/bin:/bin', `export PATH="${bin}:$PATH"`);
        put(join(root, 'install-test.sh'), sandboxed);
        const log = join(root, 'commands.jsonl');
        const result = spawnSync(bash, [join(root, 'install-test.sh'), bundle, releaseId], {
          env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, MOCK_LOG: log, MOCK_PRIOR: prior ? 'yes' : 'no', MOCK_FAILURE: failure },
          encoding: 'utf8', timeout: 30_000,
        });
        assert.equal(result.status, failure === 'collector' ? 17 : 22, result.stderr);
        assert.match(result.stderr, /Activation failed; prior service configuration restored/);
        assert(existsSync(join(appRoot, 'releases', releaseId)), 'Rejected release is retained for diagnosis');
        assert(existsSync(join(root, 'var/lib/wiki-interest')), 'Runtime data are retained');
        if (prior) {
          assert.equal(readlinkSync(join(appRoot, 'current')), 'releases/old');
          assert.equal(readFileSync(config, 'utf8'), 'previous private configuration');
          for (const unit of units) assert.equal(readFileSync(join(unitRoot, unit), 'utf8'), `previous ${unit}`);
        } else {
          assert(!existsSync(join(appRoot, 'current')));
          assert.equal(readlinkSync(join(appRoot, `.failed-current-${releaseId}`)), `releases/${releaseId}`);
          assert(!existsSync(config));
          for (const unit of units) assert(!existsSync(join(unitRoot, unit)));
        }
        const calls = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
        assert(calls.some(call => call[0] === 'systemctl' && call[1] === 'reload' && call[2] === 'nginx'));
        if (prior) for (const timer of units.filter(unit => unit.endsWith('.timer'))) assert(calls.some(call => call[0] === 'systemctl' && call[1] === 'start' && call[2] === timer));
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
}
