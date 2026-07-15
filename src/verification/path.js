import path from 'node:path';

export function isPathInside(parentDir, childPath) {
  let relative = path.relative(parentDir, childPath);
  return relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}
