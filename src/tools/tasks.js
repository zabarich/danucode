let tasks = [];
let nextId = 1;

export const definitions = [
  {
    type: 'function',
    function: {
      name: 'TaskCreate',
      description: 'Create a task to track progress. Use for multi-step tasks with 3+ distinct steps. Skip task creation for single-step tasks, trivial fixes, or conversational requests. Returns just the task ID — call TaskList after creating all tasks to show the full list.',
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
      description: 'Update a task status. Mark "in_progress" when starting, "completed" immediately when done (don\'t batch), "blocked" if stuck. Shows the full task list after updating.',
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

function renderList() {
  if (tasks.length === 0) return 'No tasks.';
  const completed = tasks.filter(t => t.status === 'completed').length;
  const lines = [];
  for (const t of tasks) {
    let icon;
    switch (t.status) {
      case 'completed': icon = '\x1b[32m■\x1b[0m'; break;
      case 'in_progress': icon = '\x1b[36m►\x1b[0m'; break;
      case 'blocked': icon = '\x1b[31m⊘\x1b[0m'; break;
      default: icon = '\x1b[2m□\x1b[0m'; break;
    }
    lines.push(`  ${icon} ${t.description}`);
  }
  return `  ${completed}/${tasks.length} done\n\n${lines.join('\n')}`;
}

export async function execute(name, args) {
  switch (name) {
    case 'TaskCreate': {
      const task = { id: nextId++, description: args.description, status: 'pending', createdAt: new Date().toISOString() };
      tasks.push(task);
      return `#${task.id}`;
    }
    case 'TaskUpdate': {
      const task = tasks.find(t => t.id === Number(args.id));
      if (!task) return `Task #${args.id} not found.`;
      task.status = args.status;
      return renderList();
    }
    case 'TaskList': {
      return renderList();
    }
    default:
      return `Unknown task command: ${name}`;
  }
}

export function getTasks() {
  return {
    tasks: tasks.map(t => ({ ...t })),
    completed: tasks.filter(t => t.status === 'completed').length,
    total: tasks.length,
  };
}
