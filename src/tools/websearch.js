import { getConfig } from '../api.js';

export const definition = {
  type: 'function',
  function: {
    name: 'WebSearch',
    description: 'Searches the web and returns results with titles, URLs, and snippets.\n\nUsage:\n- Use for documentation, error messages, APIs, libraries, and current information beyond the model knowledge cutoff.\n- Returns up to max_results results (default 5, max 10).\n- Use WebFetch to read the full content of any promising result URL.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The search query' },
        max_results: { type: 'number', description: 'Max results to return (1-10). Default: 5' },
      },
      required: ['query'],
    },
  },
};

export async function execute({ query, max_results = 5 }) {
  const config = getConfig();
  const search = config.search || {};
  const provider = search.provider || 'duckduckgo';

  switch (provider) {
    case 'brave':
      return braveSearch(query, max_results, search);
    case 'searxng':
      return searxngSearch(query, max_results, search);
    case 'duckduckgo':
    default:
      return duckduckgoSearch(query, max_results);
  }
}

// ─── DuckDuckGo (default, no key needed) ────────────────────

async function duckduckgoSearch(query, max_results) {
  const limit = Math.min(Math.max(max_results || 5, 1), 10);
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;

  let res;
  try {
    res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
      signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    if (err.name === 'TimeoutError') return 'Search timed out after 15s.';
    return `Search error: ${err.message}`;
  }

  if (!res.ok) return `Search HTTP error: ${res.status}`;

  const html = await res.text();
  return formatResults(parseDDGResults(html, limit), query);
}

function parseDDGResults(html, limit) {
  const results = [];
  const titlePattern = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippetPattern = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;

  const titles = [];
  let match;
  while ((match = titlePattern.exec(html)) !== null) {
    let url = match[1];
    const uddg = url.match(/uddg=([^&]+)/);
    if (uddg) url = decodeURIComponent(uddg[1]);
    titles.push({ url, title: stripTags(match[2]).trim() });
  }

  const snippets = [];
  while ((match = snippetPattern.exec(html)) !== null) {
    snippets.push(stripTags(match[1]).trim());
  }

  for (let i = 0; i < Math.min(titles.length, limit); i++) {
    results.push({
      title: titles[i].title || '(no title)',
      url: titles[i].url || '',
      snippet: snippets[i] || '(no snippet)',
    });
  }
  return results;
}

// ─── Brave Search (free tier: 2000 queries/month) ───────────

async function braveSearch(query, max_results, search) {
  const apiKey = search.api_key;
  if (!apiKey) return 'Brave search requires search.api_key in danu.config.json. Get one free at https://brave.com/search/api/';

  const limit = Math.min(Math.max(max_results || 5, 1), 10);
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${limit}`;

  let res;
  try {
    res = await fetch(url, {
      headers: {
        'Accept': 'application/json',
        'X-Subscription-Token': apiKey,
      },
      signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    if (err.name === 'TimeoutError') return 'Brave search timed out after 15s.';
    return `Brave search error: ${err.message}`;
  }

  if (!res.ok) return `Brave search HTTP error: ${res.status}`;

  const data = await res.json();
  const results = (data.web?.results || []).slice(0, limit).map(r => ({
    title: r.title || '(no title)',
    url: r.url || '',
    snippet: r.description || '(no snippet)',
  }));

  return formatResults(results, query);
}

// ─── SearXNG (self-hosted) ──────────────────────────────────

async function searxngSearch(query, max_results, search) {
  const baseUrl = search.base_url;
  if (!baseUrl) return 'SearXNG search requires search.base_url in danu.config.json (e.g., "http://localhost:8888")';

  const limit = Math.min(Math.max(max_results || 5, 1), 10);
  const url = `${baseUrl}/search?q=${encodeURIComponent(query)}&format=json&categories=general`;

  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  } catch (err) {
    if (err.name === 'TimeoutError') return 'SearXNG search timed out after 15s.';
    return `SearXNG search error: ${err.message}`;
  }

  if (!res.ok) return `SearXNG search HTTP error: ${res.status}`;

  const data = await res.json();
  const results = (data.results || []).slice(0, limit).map(r => ({
    title: r.title || '(no title)',
    url: r.url || '',
    snippet: r.content || '(no snippet)',
  }));

  return formatResults(results, query);
}

// ─── Shared ─────────────────────────────────────────────────

function formatResults(results, query) {
  if (results.length === 0) return `No results found for: ${query}`;
  return results.map((r, i) =>
    `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`
  ).join('\n\n');
}

function stripTags(html) {
  return html
    .replace(/<b>/gi, '').replace(/<\/b>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, ' ');
}
