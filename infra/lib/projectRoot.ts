import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Repository root (the directory holding package.json and package-lock.json).
 * Found by walking up from this module so it resolves the same way whether the
 * CDK app runs from compiled output (dist/infra/...) or from source in tests.
 */
export function projectRoot(from: string = dirname(fileURLToPath(import.meta.url))): string {
  let dir = from;
  for (;;) {
    if (existsSync(join(dir, 'package-lock.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`No package-lock.json found above ${from}`);
    dir = parent;
  }
}
