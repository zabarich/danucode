let tasks = [];
let nextId = 1;

export const definitions = [
  {
    type: 'function',
    function: {
      name: 'TaskCreate',
      description: 'Create a task to track progress. Use for multi-step tasks with 3+ distinct steps. Skip task creation for single-step tasks, trivial fixes, or conversational requests.',
      parameters: {
        type: 'object',
        properties: {
          description: { type: 'string', description: 'What needs to be done' },
        },
        required: ['description'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'TaskUpdate',
      description: 'Update a task status. Mark "in_progress" when starting, "completed" immediately when done (don\'t batch), "blocked" if stuck.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'number', description: 'Task ID' },
          status: { type: 'string', enum: ['in_progress', 'completed', 'blocked'], description: 'New status' },
        },
        required: ['id', 'status'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'TaskList',
      description: 'List all current tasks and their status. Use to check progress and decide what to work on next.',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  },
];

export async function execute(name, args) {
  switch (name) {
    case 'TaskCreate': {
      const task = { id: nextId++, description: args.description, status: 'pending', createdAt: new Date().toISOString() };
      tasks.push(task);
      return `Task #${task.id} created: ${task.description}`;
    }
    case 'TaskUpdate': {
      const task = tasks.find(t => t.id === Number(args.id));
      if (!task) return `Task #${args.id} not found.`;
      task.status = args.status;
      const icon = args.status === 'completed' ? '+' : args.status === 'in_progress' ? '>' : 'X';
      return `Task #${task.id} ${icon} ${args.status}: ${task.description}`;
    }
    case 'TaskList': {
      if (tasks.length === 0) return 'No tasks.';
      return tasks.map(t => {
        const icon = t.status === 'completed' ? '+' : t.status === 'in_progress' ? '>' : t.status === 'blocked' ? 'X' : 'o';
        return `${icon} #${t.id} [${t.status}] ${t.description}`;
      }).join('\n');
    }
    default:
      return `Unknown task command: ${name}`;
  }
}
