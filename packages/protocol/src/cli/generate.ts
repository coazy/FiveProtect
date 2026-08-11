import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';

import { renderAll } from '../generators/index.js';
import { loadRegistry } from '../schemas/index.js';
import { EXTRA_DESTINATIONS, generatedRoot, repoRoot } from './paths.js';

async function write(target: string, contents: string): Promise<void> {
  await mkdir(dirname(target), { recursive: true });
  // Written as UTF-8 with the newlines the generator produced; .gitattributes normalises
  // line endings so the drift check behaves the same on Windows and Linux.
  await writeFile(target, contents, 'utf8');
}

async function main(): Promise<void> {
  const registry = loadRegistry();
  const artifacts = renderAll(registry);
  let written = 0;

  for (const artifact of artifacts) {
    await write(join(generatedRoot, artifact.path), artifact.contents);
    written += 1;
    process.stdout.write(`  ${artifact.language.padEnd(11)} → generated/${artifact.path}\n`);

    for (const extra of EXTRA_DESTINATIONS[artifact.path] ?? []) {
      await write(extra, artifact.contents);
      written += 1;
      process.stdout.write(
        `  ${''.padEnd(11)} → ${relative(repoRoot, extra).replaceAll('\\', '/')}\n`,
      );
    }
  }

  process.stdout.write(
    `\n${written} files from ${registry.structs.length} structs, ` +
      `${registry.enums.length} enums, ${registry.constants.length} constants.\n`,
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`protocol: generation failed\n${String(error)}\n`);
  process.exitCode = 1;
});
