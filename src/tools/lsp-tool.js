import { gotoDefinition, findReferences, hover, isLspAvailable } from '../lsp.js';

export const definition = {
  type: 'function',
  function: {
    name: 'LSP',
    description: 'Query the Language Server for code intelligence. Get definitions, references, or type info for a symbol at a specific position.\n\nUsage:\n- Requires a language server for the project language. If none detected, the tool will tell you.\n- "definition": jump to where a symbol is defined.\n- "references": find all usages of a symbol.\n- "hover": get type information and documentation.\n- Positions use 1-based line numbers and 0-based character offsets.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['definition', 'references', 'hover'], description: 'What to look up' },
        file_path: { type: 'string', description: 'Absolute path to the file' },
        line: { type: 'number', description: 'Line number (1-based)' },
        character: { type: 'number', description: 'Column/character position (0-based)' },
      },
      required: ['action', 'file_path', 'line', 'character'],
    },
  },
};

export async function execute({ action, file_path, line, character }) {
  if (!isLspAvailable()) {
    return 'LSP not available. No language server detected for this project type.';
  }

  switch (action) {
    case 'definition':
      return gotoDefinition(file_path, line, character);
    case 'references':
      return findReferences(file_path, line, character);
    case 'hover':
      return hover(file_path, line, character);
    default:
      return `Unknown LSP action: ${action}`;
  }
}
