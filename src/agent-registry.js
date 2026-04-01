// Registry for tracking spawned agents so they can be continued via SendMessage

const agents = new Map();

const ADJECTIVES = ['swift', 'bold', 'keen', 'calm', 'deft', 'warm', 'cool', 'wise'];
const NOUNS = ['tui', 'kiwi', 'weka', 'ruru', 'kea', 'piwi', 'hoki', 'tuna'];

export function generateAgentId(description) {
  const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  const hex = Math.random().toString(16).slice(2, 5);
  return `${adj}-${noun}-${hex}`;
}

export function registerAgent(id, description, messages) {
  agents.set(id, {
    id,
    description: description || '',
    messages: [...messages],
    status: 'completed',
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
  });

  // Also index by description for name-based lookup
  if (description) {
    const key = description.toLowerCase().trim();
    if (!agents.has(key)) {
      agents.set(key, agents.get(id));
    }
  }
}

export function getAgent(idOrName) {
  // Direct ID lookup
  if (agents.has(idOrName)) return agents.get(idOrName);

  // Case-insensitive name search
  const lower = idOrName.toLowerCase().trim();
  if (agents.has(lower)) return agents.get(lower);

  // Partial match on description
  for (const [, agent] of agents) {
    if (agent.id === idOrName) return agent;
    if (agent.description.toLowerCase().includes(lower)) return agent;
  }

  return null;
}

export function updateAgentMessages(id, messages) {
  const agent = agents.get(id);
  if (agent) {
    agent.messages = [...messages];
    agent.lastUsedAt = Date.now();
  }
}

export function listAgents() {
  const seen = new Set();
  const result = [];
  for (const [, agent] of agents) {
    if (seen.has(agent.id)) continue;
    seen.add(agent.id);
    result.push({
      id: agent.id,
      description: agent.description,
      status: agent.status,
      messageCount: agent.messages.length,
      createdAt: agent.createdAt,
      lastUsedAt: agent.lastUsedAt,
    });
  }
  return result.sort((a, b) => b.lastUsedAt - a.lastUsedAt);
}
