import chalk from 'chalk';
import { chatCompletion } from '../api.js';
import { getAgent, updateAgentMessages } from '../agent-registry.js';
import { isContextLengthError, compactOnError } from '../context.js';

export const definition = {
  type: 'function',
  function: {
    name: 'SendMessage',
    description: 'Send a follow-up message to a previously spawned Agent, resuming it with its full conversation context preserved. The agent continues from where it left off.\n\nUsage:\n- Reference the agent by its ID (returned when the Agent tool completes).\n- The agent resumes with all its previous tool calls and results intact.\n- Use this instead of spawning a new Agent when you want to build on previous work.',
    parameters: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Agent ID or name to send the message to' },
        message: { type: 'string', description: 'The follow-up instruction or message' },
      },
      required: ['to', 'message'],
    },
  },
};

export async function execute({ to, message }) {
  const agent = getAgent(to);
  if (!agent) {
    return `No agent found with ID or name: "${to}". Use the Agent tool to spawn a new one.`;
  }

  console.log(chalk.dim(`  [SendMessage -> ${agent.id}] resuming...`));

  const { getToolDefinitions, executeTool } = await import('./index.js');
  const toolDefinitions = getToolDefinitions();

  // Resume from saved messages
  const messages = [...agent.messages];
  messages.push({ role: 'user', content: message });

  let iterationCount = 0;
  const MAX_ITERATIONS = 15;
  let lastResponse;

  while (iterationCount < MAX_ITERATIONS) {
    iterationCount++;

    let choice;
    try {
      choice = await chatCompletion(messages, toolDefinitions);
    } catch (err) {
      if (isContextLengthError(err)) {
        const compacted = await compactOnError(messages);
        messages.length = 0;
        messages.push(...compacted);
        continue;
      }
      return `SendMessage error: ${err.message}`;
    }

    const assistantMsg = choice.message;
    messages.push(assistantMsg);

    if (!assistantMsg.tool_calls || assistantMsg.tool_calls.length === 0) {
      lastResponse = assistantMsg.content || '(Agent completed with no response)';
      break;
    }

    for (const toolCall of assistantMsg.tool_calls) {
      const { name } = toolCall.function;
      let args;
      try {
        args = typeof toolCall.function.arguments === 'string'
          ? JSON.parse(toolCall.function.arguments)
          : toolCall.function.arguments;
      } catch (parseErr) {
        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          name,
          content: `Error: Invalid JSON in tool arguments: ${parseErr.message}`,
        });
        continue;
      }

      console.log(chalk.dim(`    [Agent tool: ${name}]`));
      const result = await executeTool(name, args);
      messages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        name,
        content: result,
      });
    }
  }

  if (!lastResponse) {
    const lastContent = messages[messages.length - 1].content || '(no response)';
    lastResponse = lastContent + '\n(Agent reached max iterations)';
  }

  // Save updated state back to registry
  updateAgentMessages(agent.id, messages);

  return `[Agent ${agent.id}] ${lastResponse}`;
}
