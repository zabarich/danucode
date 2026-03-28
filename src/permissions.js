import chalk from 'chalk';

let skipPermissions = false;
const sessionAllowed = new Set();
let permissionHandler = null; // Ink-based handler (set by App component)

export function setSkipPermissions(value) {
  skipPermissions = value;
}

export function getSkipPermissions() {
  return skipPermissions;
}

// Set a custom permission handler for Ink UI
export function setPermissionHandler(handler) {
  permissionHandler = handler;
}

export async function askPermission(toolName, args, rl) {
  if (skipPermissions) return true;
  if (sessionAllowed.has(toolName)) return true;

  // Ink-based handler
  if (permissionHandler) {
    const answer = await permissionHandler(toolName, args);
    if (answer === 'a' || answer === 'always') {
      sessionAllowed.add(toolName);
      return true;
    }
    return answer === 'y';
  }

  // Readline fallback
  if (rl) {
    let detail;
    switch (toolName) {
      case 'Bash': detail = args.command; break;
      case 'Write': detail = args.file_path; break;
      case 'Edit': detail = args.file_path; break;
      default: detail = `${toolName} operation`;
    }

    console.log(chalk.dim(`  ${detail}`));
    const answer = await rl.question(chalk.yellow('  Allow? ') + chalk.dim('[y/n/a(lways)] '));
    const choice = answer.trim().toLowerCase();

    if (choice === 'a' || choice === 'always') {
      sessionAllowed.add(toolName);
      return true;
    }
    return choice.startsWith('y');
  }

  // No handler and no rl — deny (fail closed)
  console.log(chalk.red('  Denied: no permission handler available'));
  return false;
}

export function resetSessionPermissions() {
  sessionAllowed.clear();
}
