import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const TEST_DIR = join(tmpdir(), 'danu-test-' + Date.now());

before(() => {
  mkdirSync(TEST_DIR, { recursive: true });
});

after(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

// ─── Read Tool ──────────────────────────────────────────────

describe('Read tool', async () => {
  const { execute } = await import('../src/tools/read.js');

  it('reads a file with line numbers', async () => {
    const file = join(TEST_DIR, 'read-test.txt');
    writeFileSync(file, 'line one\nline two\nline three\n');
    const result = await execute({ file_path: file });
    assert.match(result, /1.*line one/);
    assert.match(result, /2.*line two/);
    assert.match(result, /3.*line three/);
  });

  it('respects offset and limit', async () => {
    const file = join(TEST_DIR, 'read-offset.txt');
    writeFileSync(file, 'a\nb\nc\nd\ne\n');
    const result = await execute({ file_path: file, offset: 2, limit: 2 });
    assert.match(result, /2.*b/);
    assert.match(result, /3.*c/);
    assert.ok(!result.includes('a'));
    assert.ok(!result.includes('d'));
  });

  it('throws on non-existent file', async () => {
    await assert.rejects(
      () => execute({ file_path: join(TEST_DIR, 'nope.txt') }),
      { code: 'ENOENT' }
    );
  });
});

// ─── Write Tool ─────────────────────────────────────────────

describe('Write tool', async () => {
  const { execute } = await import('../src/tools/write.js');

  it('creates a new file', async () => {
    const file = join(TEST_DIR, 'write-new.txt');
    const result = await execute({ file_path: file, content: 'hello world\n' });
    assert.match(result, /Wrote 2 lines/);
    assert.equal(readFileSync(file, 'utf-8'), 'hello world\n');
  });

  it('overwrites existing file and reports old/new line counts', async () => {
    const file = join(TEST_DIR, 'write-overwrite.txt');
    writeFileSync(file, 'old\n');
    const result = await execute({ file_path: file, content: 'new\nline\n' });
    assert.match(result, /Overwrote/);
    assert.match(result, /was 2 lines, now 3 lines/);
  });

  it('creates parent directories', async () => {
    const file = join(TEST_DIR, 'deep', 'nested', 'file.txt');
    await execute({ file_path: file, content: 'nested\n' });
    assert.ok(existsSync(file));
  });
});

// ─── Edit Tool ──────────────────────────────────────────────

describe('Edit tool', async () => {
  const { execute } = await import('../src/tools/edit.js');

  it('replaces a unique string', async () => {
    const file = join(TEST_DIR, 'edit-test.txt');
    writeFileSync(file, 'hello world\nfoo bar\n');
    const result = await execute({ file_path: file, old_string: 'foo bar', new_string: 'baz qux' });
    assert.match(result, /Edited/);
    assert.equal(readFileSync(file, 'utf-8'), 'hello world\nbaz qux\n');
  });

  it('fails if old_string not found', async () => {
    const file = join(TEST_DIR, 'edit-notfound.txt');
    writeFileSync(file, 'hello world\n');
    const result = await execute({ file_path: file, old_string: 'nope', new_string: 'yes' });
    assert.match(result, /not found/);
  });

  it('fails if old_string matches multiple times', async () => {
    const file = join(TEST_DIR, 'edit-multi.txt');
    writeFileSync(file, 'aaa\naaa\n');
    const result = await execute({ file_path: file, old_string: 'aaa', new_string: 'bbb' });
    assert.match(result, /found 2 times/);
  });
});

// ─── Glob Tool ──────────────────────────────────────────────

describe('Glob tool', async () => {
  const { execute } = await import('../src/tools/glob.js');

  it('finds files matching a pattern', async () => {
    const dir = join(TEST_DIR, 'glob-test');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'a.js'), '');
    writeFileSync(join(dir, 'b.js'), '');
    writeFileSync(join(dir, 'c.txt'), '');
    const result = await execute({ pattern: '*.js', path: dir });
    assert.match(result, /a\.js/);
    assert.match(result, /b\.js/);
    assert.ok(!result.includes('c.txt'));
  });

  it('returns message when no files match', async () => {
    const dir = join(TEST_DIR, 'glob-empty');
    mkdirSync(dir, { recursive: true });
    const result = await execute({ pattern: '*.xyz', path: dir });
    assert.match(result, /No files matched/);
  });
});

// ─── Grep Tool ──────────────────────────────────────────────

describe('Grep tool', async () => {
  const { execute } = await import('../src/tools/grep.js');

  it('finds matching lines', async () => {
    const dir = join(TEST_DIR, 'grep-test');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'search.txt'), 'apple\nbanana\napricot\n');
    const result = await execute({ pattern: 'ap', path: dir, output_mode: 'content' });
    assert.match(result, /apple/);
    assert.match(result, /apricot/);
    assert.ok(!result.includes('banana'));
  });

  it('returns no matches message', async () => {
    const dir = join(TEST_DIR, 'grep-nomatch');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'file.txt'), 'hello\n');
    const result = await execute({ pattern: 'zzzzz', path: dir });
    assert.match(result, /No matches/);
  });
});

// ─── Patch Tool ─────────────────────────────────────────────

describe('Patch tool', async () => {
  const { execute } = await import('../src/tools/patch.js');

  it('applies a unified diff patch', async () => {
    const file = join(TEST_DIR, 'patch-test.txt');
    writeFileSync(file, 'line 1\nline 2\nline 3\n');
    const patch = `@@ -1,3 +1,3 @@
 line 1
-line 2
+line TWO
 line 3`;
    const result = await execute({ file_path: file, patch });
    assert.match(result, /Patched/);
    assert.equal(readFileSync(file, 'utf-8'), 'line 1\nline TWO\nline 3\n');
  });
});

// ─── Tasks Tool ─────────────────────────────────────────────

describe('Tasks tool', async () => {
  const tasks = await import('../src/tools/tasks.js');

  it('creates, updates, and lists tasks', async () => {
    const r1 = await tasks.execute('TaskCreate', { description: 'Test task' });
    assert.match(r1, /#\d+/);

    const r2 = await tasks.execute('TaskUpdate', { id: 1, status: 'in_progress' });
    assert.match(r2, /Test task/);
    assert.match(r2, /►/);

    const r3 = await tasks.execute('TaskList', {});
    assert.match(r3, /Test task/);

    const r4 = await tasks.execute('TaskUpdate', { id: 1, status: 'completed' });
    assert.match(r4, /■/);
    assert.match(r4, /1\/1 done/);
  });
});
