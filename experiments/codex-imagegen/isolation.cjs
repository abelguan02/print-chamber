'use strict';

const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const seatbelt = '/usr/bin/sandbox-exec';
const profile = `(version 1)
(allow default)
(deny file-write*)
(allow file-write* (subpath (param "RUN_DIR")))
(allow file-write-data (literal "/dev/null"))
(deny process-fork)
(deny process-exec)
(allow process-exec (literal (param "CLI")))
`;

// Only the user's public launcher may enter the standalone package directory.
// Validate the entire remaining destination before inspecting a private component.
async function resolveInstallPath(candidate, homeDir) {
  const privateDir = path.join(homeDir, '.codex');
  const packageDir = path.join(privateDir, 'packages', 'standalone');
  const publicLauncher = path.join(homeDir, '.local', 'bin', 'codex');
  const release = /^releases\/[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.]+)*-(?:aarch64|x86_64)-apple-darwin\/bin\/codex$/;
  const denied = () => new Error('Codex launcher points into a private user directory outside the approved installation path.');
  let parts = candidate.split(path.sep).filter(Boolean);
  let parent = path.sep;
  let links = 0;
  let fromPublicLauncher = false;
  while (parts.length) {
    const current = path.join(parent, parts.shift());
    const inPrivateDir = current === privateDir || current.startsWith(privateDir + path.sep);
    if (current === privateDir) {
      const destination = path.relative(packageDir, path.join(current, ...parts));
      if (!fromPublicLauncher || (destination !== 'current/bin/codex' && !release.test(destination))) throw denied();
    }
    try {
      const link = await fs.readlink(current);
      const target = path.resolve(parent, link);
      if (inPrivateDir && (current !== path.join(packageDir, 'current') ||
          !release.test(path.relative(packageDir, path.join(target, ...parts))))) throw denied();
      if (candidate === publicLauncher && current === publicLauncher) fromPublicLauncher = true;
      if (++links > 40) throw new Error('Too many links resolving Codex on PATH');
      parts = target.split(path.sep).filter(Boolean).concat(parts);
      parent = path.sep;
    } catch (error) {
      if (error.code !== 'EINVAL') throw error;
      parent = current;
    }
  }
  return parent;
}

async function cliOnPath(searchPath, cwd) {
  const homeDir = os.userInfo().homedir;
  const privateDir = path.join(homeDir, '.codex');
  for (const entry of searchPath.split(path.delimiter)) {
    const candidate = path.resolve(cwd, entry, 'codex');
    // Codex can prepend a private tools directory to PATH. Do not probe it.
    if (candidate.startsWith(privateDir + path.sep)) continue;
    try {
      const native = await resolveInstallPath(candidate, homeDir);
      if (!(await fs.stat(native)).isFile()) continue;
      await fs.access(native, constants.X_OK);
      return native;
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR', 'EACCES'].includes(error.code)) throw error;
    }
  }
  throw new Error('Codex executable missing from PATH');
}

function shellQuote(value) {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

async function verifyOfficialCodex(cli) {
  // Both the signed standalone release and the bundled CLI use this identifier.
  const requirement = '=anchor apple generic and certificate leaf[subject.OU] = "2DC432GLL2" and identifier "codex"';
  try {
    await promisify(execFile)('/usr/bin/codesign', ['--verify', '-R', requirement, cli], {
      env: { PATH: '/usr/bin:/bin' }, timeout: 10000,
    });
  } catch {
    throw new Error('macOS 未能验证这份 Codex 的 OpenAI 签名，已在启动前停止。');
  }
}

async function isolateGeneration(tempRoot, baseEnv, cli, verify = verifyOfficialCodex) {
  if (process.platform !== 'darwin') {
    throw new Error('Generation requires the macOS sandbox to restrict app-server writes and child commands');
  }
  const runDir = await fs.realpath(tempRoot);
  const binDir = await fs.mkdtemp(path.join(runDir, 'launcher-'));
  const file = path.join(binDir, 'generation.sb');
  await fs.writeFile(file, profile, { mode: 0o600 });
  const policy = executable => ['-D', 'RUN_DIR=' + runDir, '-D', 'CLI=' + executable, '-f', file, executable];
  try {
    await promisify(execFile)(seatbelt, policy('/usr/bin/true'), {
      cwd: runDir, env: { PATH: '/usr/bin:/bin' }, timeout: 5000,
    });
  } catch {
    throw new Error('macOS process isolation unavailable：无法启用本次进程的写入限制，已在启动 Codex 服务前停止。');
  }
  await verify(cli);
  const script = [
    '#!/bin/sh',
    'export PATH=' + shellQuote(baseEnv.PATH),
    'exec ' + [seatbelt, ...policy(cli)].map(shellQuote).join(' ') + ' "$@"',
    '',
  ].join('\n');
  await fs.writeFile(path.join(binDir, 'codex'), script, { mode: 0o700 });
  return { ...baseEnv, PATH: binDir + path.delimiter + baseEnv.PATH };
}

module.exports = { isolateGeneration, cliOnPath, resolveInstallPath };
