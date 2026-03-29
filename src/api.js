import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';

let config = null;
let loadedConfigPath = null;

function deepMerge(target, source) {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
      result[key] = deepMerge(result[key] || {}, source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

function tryLoadConfigFile(path) {
  try {
    const content = readFileSync(path, 'utf-8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

export function loadConfig(configPath) {
  const defaults = {
    timeout: 300000,
    search: { provider: 'duckduckgo' },
  };

  let merged = { ...defaults };
  const loadedFiles = [];

  const userConfigPath = resolve(homedir(), '.danu', 'config.json');
  const userConfig = tryLoadConfigFile(userConfigPath);
  if (userConfig) {
    merged = deepMerge(merged, userConfig);
    loadedFiles.push(userConfigPath);
  }

  const projectConfigPath = resolve(process.cwd(), 'danu.config.json');
  const projectConfig = tryLoadConfigFile(projectConfigPath);
  if (projectConfig) {
    merged = deepMerge(merged, projectConfig);
    loadedFiles.push(projectConfigPath);
    loadedConfigPath = projectConfigPath;
  }

  if (configPath) {
    const cliConfig = tryLoadConfigFile(configPath);
    if (cliConfig) {
      merged = deepMerge(merged, cliConfig);
      loadedFiles.push(configPath);
      loadedConfigPath = configPath;
    } else {
      throw new Error(`Cannot load config from --config path: ${configPath}`);
    }
  } else if (loadedFiles.length === 0) {
    throw new Error(
      'No config found. Create ~/.danu/config.json or ./danu.config.json:\n\n' +
      '  {\n' +
      '    "base_url": "http://localhost:8080/v1",\n' +
      '    "api_key": "your-key",\n' +
      '    "model": "your-model-name"\n' +
      '  }\n'
    );
  }

  const requiredFields = ['base_url', 'api_key', 'model'];
  const missing = requiredFields.filter(field => !merged[field]);
  if (missing.length > 0) {
    throw new Error(
      `Missing required config fields: ${missing.join(', ')}\n\n` +
      'These must be set in your config files:\n' +
      '  - base_url\n' +
      '  - api_key\n' +
      '  - model\n'
    );
  }

  config = merged;
  return { path: loadedFiles.length > 0 ? loadedFiles.join(' + ') : 'defaults', config, loadedFiles };
}

export function getConfig() {
  return config;
}

export function setModel(model) {
  if (config) config.model = model;
}

function isAnthropicProvider() {
  return config?.provider === 'anthropic' || config?.base_url?.includes('anthropic.com');
}

function convertToAnthropicRequest(messages, tools) {
  let system = '';
  const msgs = [];
  for (const msg of messages) {
    if (msg.role === 'system') {
      system += (system ? '\n' : '') + msg.content;
    } else if (msg.role === 'tool') {
      msgs.push({
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: msg.tool_call_id,
          content: msg.content,
        }],
      });
    } else if (msg.role === 'assistant' && msg.tool_calls) {
      const content = [];
      if (msg.content) content.push({ type: 'text', text: msg.content });
      for (const tc of msg.tool_calls) {
        content.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.function.name,
          input: typeof tc.function.arguments === 'string'
            ? JSON.parse(tc.function.arguments)
            : tc.function.arguments,
        });
      }
      msgs.push({ role: 'assistant', content });
    } else {
      msgs.push({ role: msg.role, content: msg.content });
    }
  }

  const anthropicTools = (tools || []).map(t => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: t.function.parameters,
  }));

  return { system, messages: msgs, tools: anthropicTools };
}

function convertFromAnthropicResponse(data) {
  const message = { role: 'assistant', content: null, tool_calls: undefined };
  const toolCalls = [];
  let textContent = '';

  for (const block of data.content || []) {
    if (block.type === 'text') {
      textContent += block.text;
    } else if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id,
        type: 'function',
        function: {
          name: block.name,
          arguments: JSON.stringify(block.input),
        },
      });
    }
  }

  message.content = textContent || null;
  if (toolCalls.length > 0) message.tool_calls = toolCalls;

  return {
    message,
    finish_reason: data.stop_reason === 'tool_use' ? 'tool_calls' : 'stop',
  };
}

export async function chatCompletion(messages, tools) {
  if (!config) throw new Error('Config not loaded. Call loadConfig() first.');
  const { base_url, api_key, model, chat_template_kwargs, timeout } = config;

  const fetchTimeout = timeout || 300000;

  if (isAnthropicProvider()) {
    const { system, messages: msgs, tools: anthropicTools } = convertToAnthropicRequest(messages, tools);
    const body = {
      model,
      system,
      messages: msgs,
      tools: anthropicTools.length > 0 ? anthropicTools : undefined,
      max_tokens: 8192,
    };

    const res = await fetch(`${base_url}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': api_key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(fetchTimeout),
    });

    if (!res.ok) { const text = await res.text(); throw new Error(`Anthropic API error ${res.status}: ${text}`); }
    const data = await res.json();
    return convertFromAnthropicResponse(data);
  }

  const body = {
    model,
    messages,
    tools,
    tool_choice: 'auto',
    ...(chat_template_kwargs && { chat_template_kwargs }),
    ...(config.extra_body && { ...config.extra_body }),
  };

  let res;
  try {
    res = await fetch(`${base_url}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${api_key}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(fetchTimeout),
    });
  } catch (err) {
    if (err.name === 'TimeoutError') {
      throw new Error(`LLM request timed out after ${Math.round(fetchTimeout / 1000)}s. The model may be overloaded.`);
    }
    throw new Error(`Cannot reach LLM at ${base_url} - is it running? (${err.message})`);
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API error ${res.status}: ${text}`);
  }

  const data = await res.json();
  return data.choices[0];
}

export async function* streamChatCompletion(messages, tools, signal) {
  if (!config) throw new Error('Config not loaded. Call loadConfig() first.');
  const { base_url, api_key, model, chat_template_kwargs, timeout } = config;

  const body = {
    model,
    messages,
    tools,
    tool_choice: 'auto',
    stream: true,
    ...(chat_template_kwargs && { chat_template_kwargs }),
    ...(config.extra_body && { ...config.extra_body }),
  };

  const fetchTimeout = timeout || 300000;
  const timeoutSignal = AbortSignal.timeout(fetchTimeout);
  const combinedSignal = signal
    ? AbortSignal.any([signal, timeoutSignal])
    : timeoutSignal;

  if (isAnthropicProvider()) {
    const { system, messages: msgs, tools: anthropicTools } = convertToAnthropicRequest(messages, tools);
    const body = {
      model,
      system,
      messages: msgs,
      tools: anthropicTools.length > 0 ? anthropicTools : undefined,
      max_tokens: 8192,
      stream: true,
    };

    const res = await fetch(`${base_url}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': api_key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
      signal: combinedSignal,
    });

    if (!res.ok) { const text = await res.text(); throw new Error(`Anthropic API error ${res.status}: ${text}`); }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let textContent = '';
    const toolCalls = [];

    try {
      while (true) {
        if (signal?.aborted) break;
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();

        let eventType = '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.startsWith('event:')) {
            eventType = trimmed.slice(6).trim();
            continue;
          }
          if (!trimmed.startsWith('data:')) continue;

          const jsonStr = trimmed.slice(5).trim();
          if (!jsonStr) continue;

          try {
            const data = JSON.parse(jsonStr);

            if (data.type === 'content_block_start' && data.content_block?.type === 'tool_use') {
              toolCalls.push({
                id: data.content_block.id,
                type: 'function',
                function: { name: data.content_block.name, arguments: '' },
              });
            } else if (data.type === 'content_block_delta') {
              if (data.delta?.type === 'text_delta' && data.delta.text) {
                textContent += data.delta.text;
                yield { type: 'text', content: data.delta.text };
              } else if (data.delta?.type === 'input_json_delta' && data.delta.partial_json) {
                const tc = toolCalls[toolCalls.length - 1];
                if (tc) tc.function.arguments += data.delta.partial_json;
              }
            } else if (data.type === 'message_stop') {
              yield {
                type: 'done',
                message: {
                  role: 'assistant',
                  content: textContent || null,
                  tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
                },
              };
            }
          } catch { /* skip invalid JSON */ }
        }
      }
    } finally {
      reader.releaseLock();
    }
    return;
  }

  let res;
  try {
    res = await fetch(`${base_url}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${api_key}`,
      },
      body: JSON.stringify(body),
      signal: combinedSignal,
    });
  } catch (err) {
    if (err.name === 'TimeoutError') {
      throw new Error(`LLM request timed out after ${Math.round(fetchTimeout / 1000)}s. The model may be overloaded.`);
    }
    throw new Error(`Cannot reach LLM at ${base_url} - is it running? (${err.message})`);
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API error ${res.status}: ${text}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const toolCallsByIndex = {};
  let contentBuffer = '';
  let doneEmitted = false;

  try {
    while (true) {
      if (signal?.aborted) break;
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');

      buffer = lines[lines.length - 1];

      for (let i = 0; i < lines.length - 1; i++) {
        const line = lines[i].trim();

        if (line === '' || line === ':') continue;

        if (line === 'data: [DONE]') {
          doneEmitted = true;
          const toolCalls = Object.keys(toolCallsByIndex)
            .sort((a, b) => parseInt(a) - parseInt(b))
            .map(idx => toolCallsByIndex[idx]);

          yield {
            type: 'done',
            message: {
              role: 'assistant',
              content: contentBuffer || null,
              tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
            },
          };
          continue;
        }

        if (line.startsWith('data: ')) {
          const jsonStr = line.slice(6);
          try {
            const data = JSON.parse(jsonStr);
            const choice = data.choices?.[0];

            if (!choice) continue;

            const delta = choice.delta || {};

            if (delta.content) {
              contentBuffer += delta.content;
              yield {
                type: 'text',
                content: delta.content,
              };
            }

            if (delta.tool_calls && Array.isArray(delta.tool_calls)) {
              for (const toolCallDelta of delta.tool_calls) {
                const idx = toolCallDelta.index;

                if (!toolCallsByIndex[idx]) {
                  toolCallsByIndex[idx] = {
                    id: toolCallDelta.id || `call_${idx}_${Date.now()}`,
                    type: toolCallDelta.type || 'function',
                    function: {
                      name: toolCallDelta.function?.name || '',
                      arguments: '',
                    },
                  };
                } else {
                  // Update name if it arrives in a later delta
                  if (toolCallDelta.function?.name) {
                    toolCallsByIndex[idx].function.name = toolCallDelta.function.name;
                  }
                }

                if (toolCallDelta.function?.arguments) {
                  toolCallsByIndex[idx].function.arguments += toolCallDelta.function.arguments;
                }
              }
            }
          } catch (parseErr) {
            // Skip invalid JSON lines
          }
        }
      }
    }

    // Final decoder flush + emit done if [DONE] was never received
    let emittedDone = false;
    const finalChunk = decoder.decode();
    if (finalChunk) {
      buffer += finalChunk;
      const lines = buffer.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed === 'data: [DONE]') {
          emittedDone = true;
          const toolCalls = Object.keys(toolCallsByIndex)
            .sort((a, b) => parseInt(a) - parseInt(b))
            .map(idx => toolCallsByIndex[idx]);

          yield {
            type: 'done',
            message: {
              role: 'assistant',
              content: contentBuffer || null,
              tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
            },
          };
        }
      }
    }

    // Safety: if stream ended without [DONE], emit done with whatever we have
    if (!doneEmitted && !emittedDone) {
      const toolCalls = Object.keys(toolCallsByIndex)
        .sort((a, b) => parseInt(a) - parseInt(b))
        .map(idx => toolCallsByIndex[idx]);

      yield {
        type: 'done',
        message: {
          role: 'assistant',
          content: contentBuffer || null,
          tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
        },
      };
    }
  } finally {
    reader.releaseLock();
  }
}
