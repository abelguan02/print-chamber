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

// Follow install links one component at a time so even an indirect link into the
// user's private Codex directory is rejected before inspecting anything there.
async function resolveInstallPath(candidate, privateDir) {
  let parts = candidate.split(path.sep).filter(Boolean);
  let parent = path.sep;
  let links = 0;
  while (parts.length) {
    const current = path.join(parent, parts.shift());
    if (current === privateDir) {
      throw new Error('Codex resolves inside its private user directory. Put a standalone native CLI first on PATH for the entire run.');
    }
    try {
      const link = await fs.readlink(current);
      if (++links > 40) throw new Error('Too many links resolving Codex on PATH');
      parts = path.resolve(parent, link).split(path.sep).filter(Boolean).concat(parts);
      parent = path.sep;
    } catch (error) {
      if (error.code !== 'EINVAL') throw error;
      parent = current;
    }
  }
  return parent;
}

async function cliOnPath(searchPath, cwd) {
  const privateDir = path.join(os.userInfo().homedir, '.codex');
  for (const entry of searchPath.split(path.delimiter)) {
    try {
      const native = await resolveInstallPath(path.resolve(cwd, entry, 'codex'), privateDir);
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

async function isolateGeneration(tempRoot, baseEnv) {
  if (process.platform !== 'darwin') {
    throw new Error('Generation requires the macOS sandbox to restrict app-server writes and child commands');
  }
  const runDir = await fs.realpath(tempRoot);
  const cli = await cliOnPath(baseEnv.PATH, runDir);
  const binDir = await fs.mkdtemp(path.join(runDir, 'launcher-'));
  const file = path.join(binDir, 'generation.sb');
  await fs.writeFile(file, profile, { mode: 0o600 });
  const policy = executable => ['-D', 'RUN_DIR=' + runDir, '-D', 'CLI=' + executable, '-f', file, executable];
  try {
    await promisify(execFile)(seatbelt, policy('/usr/bin/true'), {
      cwd: runDir, env: { PATH: '/usr/bin:/bin' }, timeout: 5000,
    });
  } catch {
    throw new Error('macOS process isolation unavailable (missing, denied or nested sandbox). Generation stopped before starting Codex.');
  }
  const script = [
    '#!/bin/sh',
    'export PATH=' + shellQuote(baseEnv.PATH),
    'exec ' + [seatbelt, ...policy(cli)].map(shellQuote).join(' ') + ' "$@"',
    '',
  ].join('\n');
  await fs.writeFile(path.join(binDir, 'codex'), script, { mode: 0o700 });
  return { ...baseEnv, PATH: binDir + path.delimiter + baseEnv.PATH };
}

module.exports = { isolateGeneration, cliOnPath };
