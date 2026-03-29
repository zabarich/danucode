import { getPR, listPRs, getPRDiff, getPRComments, createPR, getIssue, listIssues, getRepoInfo, isGhAvailable } from '../github.js';

export const definition = {
  type: 'function',
  function: {
    name: 'GitHub',
    description: 'Interact with GitHub: view PRs, issues, diffs, and create PRs.\n\nUsage:\n- Requires the gh CLI to be installed and authenticated.\n- For operations not covered by the available actions, use gh commands directly via Bash.\n- Only available when working in a git repository.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['pr_view', 'pr_list', 'pr_diff', 'pr_comments', 'pr_create', 'issue_view', 'issue_list', 'repo_info'],
          description: 'The GitHub action to perform',
        },
        number: { type: 'number', description: 'PR or issue number (for view/diff/comments actions)' },
        title: { type: 'string', description: 'PR title (for pr_create)' },
        body: { type: 'string', description: 'PR body (for pr_create)' },
        base: { type: 'string', description: 'Base branch (for pr_create, optional)' },
        state: { type: 'string', enum: ['open', 'closed', 'all'], description: 'Filter by state (for list actions). Default: open' },
      },
      required: ['action'],
    },
  },
};

export async function execute({ action, number, title, body, base, state = 'open' }) {
  if (!isGhAvailable()) {
    return 'GitHub CLI (gh) not installed. Install from https://cli.github.com/';
  }

  switch (action) {
    case 'pr_view':
      if (!number) return 'Error: number is required for pr_view';
      return getPR(number);
    case 'pr_list':
      return listPRs(state);
    case 'pr_diff':
      if (!number) return 'Error: number is required for pr_diff';
      return getPRDiff(number);
    case 'pr_comments':
      if (!number) return 'Error: number is required for pr_comments';
      return getPRComments(number);
    case 'pr_create':
      if (!title) return 'Error: title is required for pr_create';
      return createPR(title, body || '', base);
    case 'issue_view':
      if (!number) return 'Error: number is required for issue_view';
      return getIssue(number);
    case 'issue_list':
      return listIssues(state);
    case 'repo_info':
      return getRepoInfo();
    default:
      return `Unknown action: ${action}`;
  }
}
