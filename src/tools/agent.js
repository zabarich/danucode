import chalk from 'chalk';
import { chatCompletion, getConfig } from '../api.js';
import { buildSystemPrompt } from '../system-prompt.js';
import { isContextLengthError, compactOnError } from '../context.js';
import { registerAgent, generateAgentId } from '../agent-registry.js';

export const definition = {
  type: 'function',
  function: {
    name: 'Agent',
    description: 'Launch a sub-agent to handle a complex task autonomously. The agent gets its own conversation with access to all tools and returns its final text response.\n\nUsage:\n- Always include a short description (3-5 words) summarizing what the agent will do.\n- Launch multiple agents concurrently when possible to maximize performance.\n- The result is returned to you, not shown to the user. Include a concise summary in your response.\n- Provide clear, detailed prompts. State whether you expect code changes or just research.\n- Set isolation: "worktree" to run in a temporary git worktree for independent changes.\n- Prefer agents over many search commands for broad codebase exploration.',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'The task for the agent to perform' },
        description: { type: 'string', description: 'Short description of what the agent will do' },
        isolation: { type: 'string', enum: ['worktree'], description: 'Set to "worktree" to run in an isolated git worktree' },
      },
      required: ['prompt'],
    },
  },
};

export async function execute({ prompt, description, isolation }) {
  const { getToolDefinitions, executeTool } = await import('./index.js');
  const toolDefinitions = getToolDefinitions();

  const descriptionText = description || prompt.slice(0, 50);
  console.log(chalk.dim(`  [Agent: ${descriptionText}] working...`));

  const baseSystemPrompt = buildSystemPrompt();
  const systemPrompt = baseSystemPrompt + '\n\nYou are a sub-agent. Complete the assigned task and return a concise summary of what you did.';

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: prompt },
  ];

  let iterationCount = 0;
  const MAX_ITERATIONS = 15;

  let worktree = null;
  const originalCwd = process.cwd();

  if (isolation === 'worktree') {
    const { createWorktree } = await import('../worktree.js');
    worktree = createWorktree();
    if (worktree) {
      process.chdir(worktree.dir);
    }
  }

  let lastResponse;

  try {
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
        return `Agent error: ${err.message}`;
      }

      const assistantMsg = choice.message;
      messages.push(assistantMsg);

      // If assistant returned content without tool calls, that's the final answer
      if (!assistantMsg.tool_calls || assistantMsg.tool_calls.length === 0) {
        lastResponse = assistantMsg.content || '(Agent completed with no response)';
        break;
      }

      // Process each tool call
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

        // Execute the tool
        const result = await executeTool(name, args);

        // Add result to conversation
        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          name,
          content: result,
        });
      }
    }

    // Max iterations reached
    if (!lastResponse) {
      const lastContent = messages[messages.length - 1].content || '(no response)';
      lastResponse = lastContent + '\n(Agent reached max iterations)';
    }
  } finally {
    if (worktree) {
      process.chdir(originalCwd);
      const { getWorktreeChanges, removeWorktree } = await import('../worktree.js');
      const changes = getWorktreeChanges(worktree);
      if (!changes) {
        removeWorktree(worktree);
      } else {
        lastResponse += `\n\nChanges made in worktree: ${worktree.dir} (branch: ${worktree.branch})`;
      }
    }
  }

  // Register agent so it can be continued via SendMessage
  const agentId = generateAgentId(descriptionText);
  registerAgent(agentId, descriptionText, messages);

  return `[Agent ${agentId}] ${lastResponse}`;
}
