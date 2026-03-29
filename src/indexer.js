import { readFileSync, writeFileSync, existsSync, statSync, mkdirSync, readdirSync } from 'node:fs';
import { resolve, join, relative, extname, dirname, basename } from 'node:path';
import chalk from 'chalk';

const INDEX_FILE = '.danu/index.json';
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'vendor', '.danu', '.understand-anything', '__pycache__', '.venv', 'venv']);
const SOURCE_EXTS = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.go', '.rs', '.rb', '.java', '.kt', '.cs', '.php', '.vue', '.svelte']);

export function getIndexPath() {
  return resolve(process.cwd(), INDEX_FILE);
}

export function loadIndex() {
  const indexPath = getIndexPath();
  if (!existsSync(indexPath)) return null;
  try {
    return JSON.parse(readFileSync(indexPath, 'utf-8'));
  } catch {
    return null;
  }
}

export function buildIndex() {
  const cwd = process.cwd();
  const files = collectSourceFiles(cwd);
  const index = {
    root: cwd,
    builtAt: new Date().toISOString(),
    fileCount: files.length,
    files: {},
  };

  for (const filePath of files) {
    const rel = relative(cwd, filePath).replace(/\\/g, '/');
    try {
      const content = readFileSync(filePath, 'utf-8');
      const ext = extname(filePath).toLowerCase();
      const info = extractFileInfo(content, ext, rel);
      index.files[rel] = info;
    } catch {
      // Skip unreadable files
    }
  }

  // Build dependency graph
  index.dependencyGraph = buildDependencyGraph(index.files);

  // Save
  const dir = dirname(getIndexPath());
  mkdirSync(dir, { recursive: true });
  writeFileSync(getIndexPath(), JSON.stringify(index, null, 2), 'utf-8');

  return index;
}

export function updateIndex() {
  const existing = loadIndex();
  if (!existing) return buildIndex();

  const cwd = process.cwd();
  const files = collectSourceFiles(cwd);
  let updated = 0;

  for (const filePath of files) {
    const rel = relative(cwd, filePath).replace(/\\/g, '/');
    try {
      const stat = statSync(filePath);
      const mtime = stat.mtimeMs;
      const existingFile = existing.files[rel];

      if (!existingFile || !existingFile.mtime || mtime > existingFile.mtime) {
        const content = readFileSync(filePath, 'utf-8');
        const ext = extname(filePath).toLowerCase();
        existing.files[rel] = extractFileInfo(content, ext, rel);
        existing.files[rel].mtime = mtime;
        updated++;
      }
    } catch {
      // Skip
    }
  }

  // Remove deleted files
  const currentFiles = new Set(files.map(f => relative(cwd, f).replace(/\\/g, '/')));
  for (const rel of Object.keys(existing.files)) {
    if (!currentFiles.has(rel)) {
      delete existing.files[rel];
      updated++;
    }
  }

  if (updated > 0) {
    existing.builtAt = new Date().toISOString();
    existing.fileCount = Object.keys(existing.files).length;
    existing.dependencyGraph = buildDependencyGraph(existing.files);
    const dir = dirname(getIndexPath());
    mkdirSync(dir, { recursive: true });
    writeFileSync(getIndexPath(), JSON.stringify(existing, null, 2), 'utf-8');
  }

  return { index: existing, updated };
}

function collectSourceFiles(dir, depth = 0) {
  if (depth > 8) return [];
  const files = [];

  try {
    const entries = readdirSync(dir);
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry)) continue;
      if (entry.startsWith('.') && entry !== '.') continue;

      const full = join(dir, entry);
      try {
        const stat = statSync(full);
        if (stat.isDirectory()) {
          files.push(...collectSourceFiles(full, depth + 1));
        } else if (SOURCE_EXTS.has(extname(entry).toLowerCase())) {
          files.push(full);
        }
      } catch {
        // Skip inaccessible
      }
    }
  } catch {
    // Skip unreadable dirs
  }

  return files;
}

function extractFileInfo(content, ext, relPath) {
  const lines = content.split('\n');
  const info = {
    lines: lines.length,
    imports: [],
    exports: [],
    functions: [],
    classes: [],
    mtime: Date.now(),
  };

  if (['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.vue', '.svelte'].includes(ext)) {
    extractJSInfo(content, info);
  } else if (ext === '.py') {
    extractPythonInfo(content, info);
  } else if (ext === '.go') {
    extractGoInfo(content, info);
  } else if (ext === '.rs') {
    extractRustInfo(content, info);
  }

  return info;
}

function extractJSInfo(content, info) {
  // Imports
  const importRegex = /(?:import\s+(?:(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)\s+from\s+)?['"]([^'"]+)['"]|require\s*\(\s*['"]([^'"]+)['"]\s*\))/g;
  let match;
  while ((match = importRegex.exec(content)) !== null) {
    const mod = match[1] || match[2];
    if (mod && !info.imports.includes(mod)) info.imports.push(mod);
  }

  // Exports
  const exportRegex = /export\s+(?:default\s+)?(?:function|class|const|let|var|async\s+function)\s+(\w+)/g;
  while ((match = exportRegex.exec(content)) !== null) {
    if (!info.exports.includes(match[1])) info.exports.push(match[1]);
  }

  // module.exports
  const moduleExportRegex = /module\.exports\s*=\s*(?:\{([^}]+)\}|(\w+))/g;
  while ((match = moduleExportRegex.exec(content)) !== null) {
    if (match[1]) {
      match[1].split(',').map(s => s.trim().split(':')[0].trim()).filter(Boolean).forEach(e => {
        if (!info.exports.includes(e)) info.exports.push(e);
      });
    } else if (match[2]) {
      if (!info.exports.includes(match[2])) info.exports.push(match[2]);
    }
  }

  // Functions
  const funcRegex = /(?:export\s+)?(?:async\s+)?function\s+(\w+)/g;
  while ((match = funcRegex.exec(content)) !== null) {
    if (!info.functions.includes(match[1])) info.functions.push(match[1]);
  }

  // Classes
  const classRegex = /(?:export\s+)?class\s+(\w+)/g;
  while ((match = classRegex.exec(content)) !== null) {
    if (!info.classes.includes(match[1])) info.classes.push(match[1]);
  }
}

function extractPythonInfo(content, info) {
  let match;
  const importRegex = /^(?:from\s+(\S+)\s+import|import\s+(\S+))/gm;
  while ((match = importRegex.exec(content)) !== null) {
    const mod = match[1] || match[2];
    if (mod && !info.imports.includes(mod)) info.imports.push(mod);
  }

  const funcRegex = /^def\s+(\w+)/gm;
  while ((match = funcRegex.exec(content)) !== null) {
    if (!info.functions.includes(match[1])) info.functions.push(match[1]);
  }

  const classRegex = /^class\s+(\w+)/gm;
  while ((match = classRegex.exec(content)) !== null) {
    if (!info.classes.includes(match[1])) info.classes.push(match[1]);
  }
}

function extractGoInfo(content, info) {
  let match;
  const importRegex = /import\s+(?:\(\s*([\s\S]*?)\s*\)|"([^"]+)")/g;
  while ((match = importRegex.exec(content)) !== null) {
    if (match[2]) {
      info.imports.push(match[2]);
    } else if (match[1]) {
      match[1].match(/"([^"]+)"/g)?.forEach(m => info.imports.push(m.replace(/"/g, '')));
    }
  }

  const funcRegex = /^func\s+(?:\([^)]*\)\s+)?(\w+)/gm;
  while ((match = funcRegex.exec(content)) !== null) {
    if (!info.functions.includes(match[1])) info.functions.push(match[1]);
  }

  const typeRegex = /^type\s+(\w+)\s+struct/gm;
  while ((match = typeRegex.exec(content)) !== null) {
    if (!info.classes.includes(match[1])) info.classes.push(match[1]);
  }
}

function extractRustInfo(content, info) {
  let match;
  const useRegex = /^use\s+([^;]+)/gm;
  while ((match = useRegex.exec(content)) !== null) {
    info.imports.push(match[1].trim());
  }

  const fnRegex = /^pub\s+(?:async\s+)?fn\s+(\w+)/gm;
  while ((match = fnRegex.exec(content)) !== null) {
    if (!info.functions.includes(match[1])) info.functions.push(match[1]);
  }

  const structRegex = /^pub\s+struct\s+(\w+)/gm;
  while ((match = structRegex.exec(content)) !== null) {
    if (!info.classes.includes(match[1])) info.classes.push(match[1]);
  }
}

function buildDependencyGraph(files) {
  const graph = { dependsOn: {}, dependedOnBy: {} };

  for (const [filePath, info] of Object.entries(files)) {
    graph.dependsOn[filePath] = [];
    for (const imp of info.imports) {
      // Resolve relative imports to file paths
      if (imp.startsWith('.')) {
        const dir = dirname(filePath);
        let resolved = join(dir, imp).replace(/\\/g, '/');
        // Try with common extensions
        const candidates = [resolved, resolved + '.js', resolved + '.ts', resolved + '.jsx', resolved + '.tsx', resolved + '/index.js', resolved + '/index.ts'];
        const found = candidates.find(c => files[c]);
        if (found) {
          graph.dependsOn[filePath].push(found);
          if (!graph.dependedOnBy[found]) graph.dependedOnBy[found] = [];
          graph.dependedOnBy[found].push(filePath);
        }
      }
    }
  }

  return graph;
}

// Generate a compact summary for injection into the system prompt
export function getIndexSummary(index) {
  if (!index) return '';

  const files = Object.entries(index.files);
  if (files.length === 0) return '';

  let summary = `\n\n## Codebase Index (${index.fileCount} files, indexed ${index.builtAt.split('T')[0]})\n\n`;

  for (const [path, info] of files) {
    const parts = [];
    if (info.exports.length > 0) parts.push(`exports: ${info.exports.join(', ')}`);
    if (info.classes.length > 0) parts.push(`classes: ${info.classes.join(', ')}`);
    if (info.functions.length > 0 && info.functions.length <= 8) parts.push(`functions: ${info.functions.join(', ')}`);
    else if (info.functions.length > 8) parts.push(`functions: ${info.functions.slice(0, 6).join(', ')} +${info.functions.length - 6} more`);

    const deps = index.dependencyGraph?.dependedOnBy?.[path];
    if (deps && deps.length > 0) parts.push(`used by: ${deps.join(', ')}`);

    if (parts.length > 0) {
      summary += `- \`${path}\` (${info.lines}L) — ${parts.join(' | ')}\n`;
    } else {
      summary += `- \`${path}\` (${info.lines}L)\n`;
    }
  }

  return summary;
}
