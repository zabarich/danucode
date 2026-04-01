// JSONL append-only history with up-arrow recall
import { appendFileSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const HISTORY_FILE = join(homedir(), '.danu', 'history.jsonl');

// In-memory session history for fast up-arrow
let sessionHistory = [];

export function addToHistory(display, project, sessionId) {
  if (!display?.trim()) return;
  const entry = {
    display: display.trim(),
    timestamp: Date.now(),
    project: project || process.cwd(),
    sessionId: sessionId || '',
  };

  sessionHistory.push(entry.display);

  try {
    mkdirSync(join(homedir(), '.danu'), { recursive: true });
    appendFileSync(HISTORY_FILE, JSON.stringify(entry) + '\n', 'utf-8');
  } catch {
    // Non-fatal — history is best-effort
  }
}

export function getSessionHistory() {
  return sessionHistory;
}

export function getHistory(project, maxItems = 200) {
  const results = [];
  const seen = new Set();

  // Session entries first (most recent at end, reverse for up-arrow)
  for (let i = sessionHistory.length - 1; i >= 0 && results.length < maxItems; i--) {
    const text = sessionHistory[i];
    if (!seen.has(text)) {
      seen.add(text);
      results.push(text);
    }
  }

  // Then cross-session entries from disk
  try {
    const content = readFileSync(HISTORY_FILE, 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);

    for (let i = lines.length - 1; i >= 0 && results.length < maxItems; i--) {
      try {
        const entry = JSON.parse(lines[i]);
        // Prefer same-project history
        if (project && entry.project !== project) continue;
        if (!seen.has(entry.display)) {
          seen.add(entry.display);
          results.push(entry.display);
        }
      } catch {
        // Skip corrupt lines
      }
    }
  } catch {
    // No history file yet
  }

  return results;
}
