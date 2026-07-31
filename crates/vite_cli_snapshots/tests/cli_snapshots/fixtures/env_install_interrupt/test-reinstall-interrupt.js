const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const scopeDir = path.join(process.env.VP_HOME, 'packages', '@scope');
const before = new Set(fs.readdirSync(scopeDir));

const child = spawn('vp', ['install', '-g', './long-time-install-package'], {
  stdio: 'inherit',
});

// A fixed kill delay races vp's startup: on slow runners it can fire before
// the reinstall creates its install dir, leaving nothing stale. Kill as soon
// as the new dir appears; the package's 200ms postinstall keeps the install
// running well past that point.
const poll = setInterval(() => {
  let entries;
  try {
    entries = fs.readdirSync(scopeDir);
  } catch {
    return;
  }
  if (entries.some((name) => !before.has(name))) {
    clearInterval(poll);
    child.kill('SIGKILL');
  }
}, 10);

// Bound the wait so a reinstall that dies before creating the dir cannot
// hang the case.
const fallback = setTimeout(() => {
  clearInterval(poll);
  if (!child.killed) {
    child.kill('SIGKILL');
  }
}, 10_000);

child.on('close', (code) => {
  clearInterval(poll);
  clearTimeout(fallback);
  process.exit(code);
});
