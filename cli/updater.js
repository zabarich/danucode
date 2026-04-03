import chalk from 'chalk';

const CURRENT_VERSION = '1.1.0';

export function getVersion() {
  return CURRENT_VERSION;
}

export async function checkForUpdates() {
  try {
    const res = await fetch('https://registry.npmjs.org/danu/latest', {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (data.version && data.version !== CURRENT_VERSION) {
      return { current: CURRENT_VERSION, latest: data.version };
    }
  } catch {
    // Not published to npm or offline — that's fine
  }
  return null;
}

export function showUpdateNotice(update) {
  if (!update) return;
  console.log(chalk.yellow(`\n  Update available: ${update.current} → ${update.latest}`));
  console.log(chalk.dim('  Run: cd <danu-dir> && git pull && npm install'));
}
