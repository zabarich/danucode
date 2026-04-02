// Danucode native adapter — wraps the existing conversation system.
// Deep supervision: full structured events from loop.js + event-adapter.

import { createConversation } from '../loop.js';
import { handleCommand, setConversationRef } from '../commands.js';
import { setPermissionHandler } from '../permissions.js';
import { estimateTokens } from '../context.js';
import { getCurrentMode, getModeConfig } from '../modes.js';
import { getConfig } from '../api.js';
import { getFileAccessCounts } from '../loop.js';
import { addToHistory } from '../history.js';

export const meta = {
  id: 'danucode',
  name: 'Danucode',
  supervision: 'deep',
  description: 'Native backend with full structured tool events',
};

export function createSession(tabId, cwd, _config) {
  const conversation = createConversation(tabId);
  return {
    id: tabId,
    backend: 'danucode',
    supervision: 'deep',
    conversation,
    abort: null,
    busy: false,
  };
}

export async function sendMessage(session, message, permissionHandler) {
  session.busy = true;
  setConversationRef(session.conversation);
  if (permissionHandler) setPermissionHandler(permissionHandler);
  addToHistory(message, '', '');

  session.abort = new AbortController();

  const handled = await handleCommand(message, session.conversation);
  if (!handled) {
    await session.conversation.send(message, null, session.abort.signal);
  }

  session.abort = null;
  session.busy = false;
}

export function stopSession(session) {
  if (session.abort) {
    session.abort.abort();
    session.abort = null;
  }
}

export function destroySession(session) {
  stopSession(session);
  session.conversation = null;
}

export function getStatus(session, cwd) {
  const config = getConfig();
  const mode = getCurrentMode();
  const modeConfig = getModeConfig();
  const tokens = session.conversation ? estimateTokens(session.conversation.getMessages()) : 0;
  const maxTokens = config?.max_context_tokens || 64000;
  const fileAccess = getFileAccessCounts();
  const filesEdited = fileAccess.filter(f => f.tools.includes('Edit') || f.tools.includes('Write')).length;

  return {
    model: config?.model || 'unknown',
    provider: config?.provider || config?.base_url || 'local',
    mode,
    shellAllowed: modeConfig.allowedTools === null || modeConfig.allowedTools?.has('Bash'),
    editAllowed: modeConfig.allowedTools === null || modeConfig.allowedTools?.has('Edit'),
    tokenEstimate: tokens,
    maxTokens,
    filesEdited,
  };
}
