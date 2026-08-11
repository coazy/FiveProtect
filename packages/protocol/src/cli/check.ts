import { readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

import { renderAll } from '../generators/index.js';
import { loadRegistry } from '../schemas/index.js';
import { EXTRA_DESTINATIONS, generatedRoot, repoRoot } from './paths.js';

/**
 * Fails when a committed artifact disagrees with the schemas.
 *
 * This is the mechanism behind ADR 0001: the artifacts are committed so Rust, C++ and Lua
 * build without Node, and this check is what stops them going stale. It compares content
 * rather than regenerating in place, so a red build never silently fixes itself.
 */
async function main(): Promise<void> {
  const registry = loadRegistry();
  const artifacts = renderAll(registry);
  const problems: string[] = [];
  let checked = 0;

  const compare = async (target: string, expected: string, label: string): Promise<void> => {
    checked += 1;
    let actual: string;
    try {
      actual = await readFile(target, 'utf8');
    } catch {
      problems.push(`missing: ${label}`);
      return;
    }

    // Normalise line endings only. Anything else the generator controls, and a difference
    // there is real drift.
    if (actual.replace(/\r\n/g, '\n') !== expected.replace(/\r\n/g, '\n')) {
      problems.push(`out of date: ${label} (${firstDifference(actual, expected)})`);
      return;
    }
    process.stdout.write(`  ok  ${label}\n`);
  };

  for (const artifact of artifacts) {
    await compare(
      join(generatedRoot, artifact.path),
      artifact.contents,
      `generated/${artifact.path}`,
    );

    for (const extra of EXTRA_DESTINATIONS[artifact.path] ?? []) {
      await compare(extra, artifact.contents, relative(repoRoot, extra).replaceAll('\\', '/'));
    }
  }

  if (problems.length > 0) {
    process.stderr.write(
      '\nProtocol artifacts do not match the schemas:\n' +
        problems.map((p) => `  - ${p}`).join('\n') +
        '\n\nRun `npm run protocol:generate` and commit the result.\n',
    );
    process.exitCode = 1;
    return;
  }

  process.stdout.write(`\nAll ${checked} files match the schemas.\n`);
}

function firstDifference(actual: string, expected: string): string {
  const a = actual.replace(/\r\n/g, '\n').split('\n');
  const b = expected.replace(/\r\n/g, '\n').split('\n');
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if (a[i] !== b[i]) {
      return `first difference at line ${i + 1}`;
    }
  }
  return 'lengths differ';
}

main().catch((error: unknown) => {
  process.stderr.write(`protocol: check failed\n${String(error)}\n`);
  process.exitCode = 1;
});
