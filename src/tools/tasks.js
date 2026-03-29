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
      let icon;
      switch(args.status) {
        case 'completed': icon = '■'; break;
        case 'in_progress': icon = '►'; break;
        case 'blocked': icon = '⊘'; break;
        default: icon = '□'; break;
      }
      return `${icon} #${task.id}  ${task.description}  →  ${args.status}`;
    }
    case 'TaskList': {
      if (tasks.length === 0) return 'No tasks.';
      const completed = tasks.filter(t => t.status === 'completed').length;
      let out = `  Tasks (${completed}/${tasks.length} completed)\n\n`;
      for (const t of tasks) {
        let icon, color;
        switch(t.status) {
          case 'completed': icon = '■'; color = '\x1b[32m'; break;
          case 'in_progress': icon = '►'; color = '\x1b[36m'; break;
          case 'blocked': icon = '⊘'; color = '\x1b[31m'; break;
          default: icon = '□'; color = '\x1b[2m'; break;
        }
        const pad = t.description.length < 40 ? ' '.repeat(40 - t.description.length) : '  ';
        out += `  ${color}${icon}\x1b[0m #${t.id}  ${t.description}${pad}${t.status}\n`;
      }
      return out;
    }
    default:
      return `Unknown task command: ${name}`;
  }
}
