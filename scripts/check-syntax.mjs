import { readdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';

async function collectJavaScriptFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      files.push(...(await collectJavaScriptFiles(fullPath)));
      continue;
    }

    if (entry.isFile() && fullPath.endsWith('.js')) {
      files.push(fullPath);
    }
  }

  return files;
}

async function main() {
  const targets = [path.join(process.cwd(), 'src'), path.join(process.cwd(), 'scripts')];
  const files = [];

  for (const target of targets) {
    files.push(...(await collectJavaScriptFiles(target)));
  }

  for (const file of files) {
    const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });

    if (result.status !== 0) {
      process.exit(result.status ?? 1);
    }
  }

  console.log(`Kuruma syntax check passed for ${files.length} files.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
