import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vite-plus/test';
import { createCLI } from 'vitest/node';

import { extractCompletionMetadata } from '../../build/completion-metadata.ts';
import { VITEST_VERSION } from '../utils/constants.ts';

type CLI = ReturnType<typeof createCLI>;

function metadata(cli = createCLI()) {
  return extractCompletionMetadata(cli, '1.3.0', VITEST_VERSION);
}

// These checks exercise the public surface consumed by the adapter. Command
// names, counts, aliases, descriptions and parser transforms are not frozen.
describe('public createCLI metadata contract (installed Vitest)', () => {
  it('reads command and option fields through the public return type', () => {
    const cli: CLI = createCLI();
    for (const command of [cli.globalCommand, ...cli.commands]) {
      expect(typeof command.name).toBe('string');
      expect(typeof command.rawName).toBe('string');
      for (const option of command.options) {
        const declaration: {
          rawName: string;
          description: string;
          isBoolean?: boolean;
          required?: boolean;
          negated: boolean;
        } = option;
        expect(typeof declaration.rawName).toBe('string');
        expect(typeof declaration.description).toBe('string');
        expect(typeof declaration.negated).toBe('boolean');
      }
    }
  });

  it('projects the current public definitions without a fixed upstream inventory', () => {
    const cli = createCLI();
    const data = metadata(cli);
    expect(data.commands.map((command) => command.name)).toEqual(
      cli.commands.map((command) => command.name),
    );
    const sourceScopes = [cli.globalCommand, ...cli.commands];
    const targetScopes = [data.globalOptions, ...data.commands.map((command) => command.options)];
    for (const [index, source] of sourceScopes.entries()) {
      expect(targetScopes[index]).toHaveLength(source.options.length);
      for (const [optionIndex, option] of source.options.entries()) {
        expect(targetScopes[index][optionIndex]).toMatchObject({
          rawName: option.rawName,
          description: option.description ?? '',
          negated: option.negated,
          valueMode: option.isBoolean ? 'none' : option.required ? 'required' : 'optional',
        });
      }
    }
    for (const [index, command] of cli.commands.entries()) {
      expect(data.commands[index]).toMatchObject({
        rawName: command.rawName,
        description: command.description ?? '',
      });
    }
  });

  it('is read-only and never calls parse or command actions during extraction', () => {
    const cli = createCLI();
    const before = metadata(cli);
    cli.parse = () => {
      throw new Error('Must not parse during metadata extraction');
    };
    for (const command of cli.commands) {
      command.action(() => {
        throw new Error('Must not run actions during metadata extraction');
      });
    }
    Object.freeze(cli.globalCommand.options);
    for (const command of [cli.globalCommand, ...cli.commands]) {
      for (const option of command.options) {
        Object.freeze(option);
      }
      Object.freeze(command.options);
      Object.freeze(command);
    }
    Object.freeze(cli.commands);
    expect(metadata(cli)).toEqual(before);
  });

  it('returns deterministic serializable definitions synchronously', async () => {
    const cli = createCLI();
    const before = metadata(cli);
    expect(JSON.parse(JSON.stringify(before))).toEqual(before);
    expect(metadata()).toEqual(before);
    await Promise.resolve();
    expect(metadata(cli)).toEqual(before);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(metadata(cli)).toEqual(before);
  });

  it('constructs without parsing argv, loading project config or running actions', () => {
    const require = createRequire(import.meta.url);
    const entry = require.resolve('vitest/node');
    const script = `
      import { pathToFileURL } from 'node:url';
      const {createCLI} = await import(pathToFileURL(${JSON.stringify(entry)}));
      // If construction accidentally starts CLI parsing, help produces output.
      process.argv = ['node', 'vitest', 'run', '--help'];
      createCLI();
      await new Promise(resolve => setImmediate(resolve));
    `;
    const directory = mkdtempSync(path.join(os.tmpdir(), 'vp-createcli-contract-'));
    try {
      for (const name of ['vite.config.ts', 'vitest.config.ts']) {
        writeFileSync(
          path.join(directory, name),
          "throw new Error('Must not load project config');",
        );
      }
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
        cwd: directory,
        encoding: 'utf8',
        timeout: 15_000,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe('');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
