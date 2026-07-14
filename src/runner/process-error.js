export function boundedProcessError(stderr, exitCode, limit = 2000) {
  let text = String(stderr ?? '')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replaceAll('\0', '')
    .trim();
  if (!text) text = `Process exited with code ${exitCode ?? 'unknown'}`;
  return text.slice(0, limit);
}
