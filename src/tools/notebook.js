import { readFile, writeFile } from 'node:fs/promises';

export const definition = {
  type: 'function',
  function: {
    name: 'NotebookEdit',
    description: 'Edit a Jupyter notebook (.ipynb file). Can replace, insert, or delete cells.\n\nUsage:\n- "replace": overwrite a cell content and type.\n- "insert": add a new cell at a given index.\n- "delete": remove a cell at a given index.\n- Cell types: "code" for executable, "markdown" for text.\n- Cell indices are 0-based.\n- Use Read to view notebook contents before editing.',
    parameters: {
      type: 'object',
      properties: {
        notebook_path: { type: 'string', description: 'Absolute path to the .ipynb file' },
        cell_index: { type: 'number', description: 'Index of the cell to edit (0-based)' },
        action: { type: 'string', enum: ['replace', 'insert', 'delete'], description: 'What to do' },
        cell_type: { type: 'string', enum: ['code', 'markdown'], description: 'Cell type (for replace/insert)' },
        source: { type: 'string', description: 'Cell content (for replace/insert)' },
      },
      required: ['notebook_path', 'cell_index', 'action'],
    },
  },
};

export async function execute({ notebook_path, cell_index, action, cell_type = 'code', source = '' }) {
  const raw = await readFile(notebook_path, 'utf-8');
  const nb = JSON.parse(raw);

  if (!nb.cells || !Array.isArray(nb.cells)) {
    return 'Error: Not a valid Jupyter notebook (no cells array).';
  }

  switch (action) {
    case 'replace': {
      if (cell_index < 0 || cell_index >= nb.cells.length) {
        return `Error: Cell index ${cell_index} out of range (0-${nb.cells.length - 1}).`;
      }
      nb.cells[cell_index] = makeCell(cell_type, source);
      break;
    }
    case 'insert': {
      if (cell_index < 0 || cell_index > nb.cells.length) {
        return `Error: Insert index ${cell_index} out of range (0-${nb.cells.length}).`;
      }
      nb.cells.splice(cell_index, 0, makeCell(cell_type, source));
      break;
    }
    case 'delete': {
      if (cell_index < 0 || cell_index >= nb.cells.length) {
        return `Error: Cell index ${cell_index} out of range (0-${nb.cells.length - 1}).`;
      }
      nb.cells.splice(cell_index, 1);
      break;
    }
    default:
      return `Unknown action: ${action}`;
  }

  await writeFile(notebook_path, JSON.stringify(nb, null, 1), 'utf-8');
  return `Notebook ${action}d cell at index ${cell_index} in ${notebook_path} (${nb.cells.length} cells total)`;
}

function makeCell(type, source) {
  return {
    cell_type: type,
    metadata: {},
    source: source ? source.split('\n').map((line, i, arr) => i < arr.length - 1 ? line + '\n' : line) : [],
    ...(type === 'code' ? { execution_count: null, outputs: [] } : {}),
  };
}
