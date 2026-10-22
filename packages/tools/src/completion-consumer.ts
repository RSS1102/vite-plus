import { execFileSync } from 'node:child_process';
import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs';
import path from 'node:path';

const repository = path.resolve(import.meta.dirname, '../../..');

/** Use only the artifact supplied by the build or CI restore step, never PATH or mtime. */
export function resolveCompletionConsumer(
  root = repository,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const supplied = env.VP_COMPLETION_CONSUMER_BIN;
  if (!supplied) {
    throw new Error(
      'Missing VP_COMPLETION_CONSUMER_BIN. Run pnpm test:completion (builds Rust), or export the exact restored CI artifact before running tests.',
    );
  }
  const binary = path.resolve(root, supplied);
  if (!existsSync(binary) || !statSync(binary).isFile()) {
    throw new Error(`Rust completion consumer does not exist: ${binary}`);
  }
  const fd = openSync(binary, 'r');
  const header = Buffer.alloc(4);
  try {
    readSync(fd, header, 0, header.length, 0);
  } finally {
    closeSync(fd);
  }
  const magic = header.toString('hex');
  const native =
    process.platform === 'win32'
      ? magic.startsWith('4d5a')
      : process.platform === 'darwin'
        ? [
            'cffaedfe',
            'cefaedfe',
            'feedfacf',
            'feedface',
            'cafebabe',
            'bebafeca',
            'cafebabf',
            'bfbafeca',
          ].includes(magic)
        : magic === '7f454c46';
  if (!native || (process.platform !== 'win32' && !(statSync(binary).mode & 0o111))) {
    throw new Error(`Completion consumer must be a native executable: ${binary}`);
  }
  return binary;
}

/** Cargo's executable field already accounts for config, target-dir, target and profile. */
export function cargoCompletionConsumer(output: string, root: string): string {
  const executables = new Set<string>();
  for (const line of output.split('\n').filter(Boolean)) {
    const message = JSON.parse(line) as {
      reason?: string;
      target?: { name?: string; kind?: string[] };
      executable?: string | null;
    };
    if (
      message.reason === 'compiler-artifact' &&
      message.target?.name === 'vp' &&
      message.target.kind?.includes('bin') &&
      typeof message.executable === 'string'
    ) {
      executables.add(path.resolve(root, message.executable));
    }
  }
  if (executables.size !== 1) {
    throw new Error(`Expected one Cargo vp executable, received ${executables.size}`);
  }
  return [...executables][0];
}

export function buildCompletionConsumer(
  root = repository,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const output = execFileSync(
    process.platform === 'win32' ? 'cargo.exe' : 'cargo',
    ['build', '-p', 'vp_global_cli', '--message-format=json'],
    {
      cwd: root,
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  return resolveCompletionConsumer(root, {
    VP_COMPLETION_CONSUMER_BIN: cargoCompletionConsumer(output, root),
  });
}
