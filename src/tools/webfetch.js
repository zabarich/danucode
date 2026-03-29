export const definition = {
  type: 'function',
  function: {
    name: 'WebFetch',
    description: 'Fetches a URL and returns the content as readable text. HTML is converted to plain text.\n\nUsage:\n- The URL must be fully formed (e.g., https://example.com/page).\n- HTTP URLs are automatically upgraded to HTTPS.\n- Use for docs pages, GitHub READMEs, blog posts, API references.\n- For GitHub repository data, prefer using gh CLI via Bash instead.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The URL to fetch' },
        max_length: { type: 'number', description: 'Max characters to return. Default: 20000' },
      },
      required: ['url'],
    },
  },
};

export async function execute({ url, max_length = 20000 }) {
  let fetchUrl = url;
  if (fetchUrl.startsWith('/') || fetchUrl.startsWith('.')) {
    return 'Error: Provide a full URL (e.g., https://example.com), not a file path.';
  }
  if (fetchUrl.startsWith('http://')) {
    fetchUrl = fetchUrl.replace('http://', 'https://');
  }
  if (!fetchUrl.startsWith('https://')) {
    fetchUrl = 'https://' + fetchUrl;
  }

  let res;
  try {
    res = await fetch(fetchUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; Danu/0.1)',
        'Accept': 'text/html,application/xhtml+xml,application/json,text/plain,*/*',
      },
      signal: AbortSignal.timeout(30000),
      redirect: 'follow',
    });
  } catch (err) {
    if (err.name === 'TimeoutError') return `Fetch timed out after 30s: ${fetchUrl}`;
    return `Fetch error: ${err.message}`;
  }

  if (!res.ok) {
    return `HTTP ${res.status}: ${res.statusText} for ${fetchUrl}`;
  }

  const contentType = res.headers.get('content-type') || '';
  const text = await res.text();

  let result;
  if (contentType.includes('text/html') || contentType.includes('xhtml')) {
    result = htmlToText(text);
  } else {
    result = text;
  }

  if (result.length > max_length) {
    result = result.slice(0, max_length) + `\n\n... (truncated at ${max_length} chars)`;
  }

  return result || '(empty page)';
}

function htmlToText(html) {
  // Remove script, style, nav, header, footer tags and their content
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '');

  // Convert common elements to readable text
  text = text
    .replace(/<title[^>]*>([\s\S]*?)<\/title>/gi, '# $1\n\n')
    .replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, '\n# $1\n')
    .replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, '\n## $1\n')
    .replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, '\n### $1\n')
    .replace(/<h[456][^>]*>([\s\S]*?)<\/h[456]>/gi, '\n#### $1\n')
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, '- $1\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, '$1\n\n')
    .replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, '\n```\n$1\n```\n')
    .replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, '`$1`')
    .replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, '$2 ($1)')
    .replace(/<strong[^>]*>([\s\S]*?)<\/strong>/gi, '**$1**')
    .replace(/<b[^>]*>([\s\S]*?)<\/b>/gi, '**$1**')
    .replace(/<em[^>]*>([\s\S]*?)<\/em>/gi, '*$1*')
    .replace(/<i[^>]*>([\s\S]*?)<\/i>/gi, '*$1*');

  // Strip remaining HTML tags
  text = text.replace(/<[^>]+>/g, '');

  // Decode HTML entities
  text = text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n));

  // Clean up whitespace
  text = text
    .replace(/\t/g, ' ')
    .replace(/ +/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n')
    .map(l => l.trim())
    .join('\n')
    .trim();

  return text;
}
