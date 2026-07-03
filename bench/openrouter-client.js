const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';
const DEFAULT_TITLE = 'agent-pool-mcp shturman bench';

function resolveApiKey(apiKey) {
  let resolved = apiKey || process.env.OPENROUTER_API_KEY || '';
  if (!resolved) {
    throw new Error('OpenRouter API key missing. Set OPENROUTER_API_KEY before running the bench.');
  }
  return resolved;
}

function resolveFetch(fetchImpl) {
  let resolved = fetchImpl || globalThis.fetch;
  if (typeof resolved !== 'function') {
    throw new Error('No fetch implementation available for OpenRouter client.');
  }
  return resolved;
}

function readContent(json) {
  let choice = json?.choices?.[0];
  let content = choice?.message?.content ?? choice?.text ?? '';
  if (Array.isArray(content)) {
    return content
      .map(part => typeof part === 'string' ? part : part?.text ?? '')
      .filter(Boolean)
      .join('\n');
  }
  return typeof content === 'string' ? content : JSON.stringify(content ?? '');
}

function readCost(json) {
  let candidates = [
    json?.openrouter_metadata?.total_cost,
    json?.openrouter_metadata?.cost,
    json?.usage?.cost,
    json?.usage?.cost_usd,
  ];
  let value = candidates.find(item => item !== undefined && item !== null);
  return value === undefined ? null : Number(value);
}

function buildProviderRoute(options = {}) {
  let order = Array.isArray(options.providerOrder)
    ? options.providerOrder
    : options.provider
      ? [options.provider]
      : [];

  return {
    ...(order.length ? { order } : {}),
    allow_fallbacks: options.allowFallbacks === true,
    data_collection: options.dataCollection || 'deny',
  };
}

/**
 * @param {object} [options]
 * @returns {{ complete: (request: object) => Promise<object> }}
 */
export function createOpenRouterClient(options = {}) {
  let apiKey = resolveApiKey(options.apiKey);
  let fetchImpl = resolveFetch(options.fetchImpl);
  let baseUrl = options.baseUrl || DEFAULT_BASE_URL;
  let appTitle = options.appTitle || DEFAULT_TITLE;
  let referer = options.referer || null;

  return {
    async complete(request) {
      let startedAt = Date.now();
      let body = {
        model: request.model,
        messages: request.messages,
        temperature: request.temperature ?? 0,
        ...(request.maxTokens ? { max_tokens: request.maxTokens } : {}),
        provider: buildProviderRoute(request),
      };

      let response = await fetchImpl(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'X-Title': appTitle,
          'X-OpenRouter-Metadata': 'enabled',
          ...(referer ? { 'HTTP-Referer': referer } : {}),
        },
        body: JSON.stringify(body),
        signal: request.signal,
      });

      let responseText = await response.text();
      if (!response.ok) {
        throw new Error(
          `OpenRouter chat completion failed with HTTP ${response.status}: ${responseText}`,
        );
      }

      let json = JSON.parse(responseText);
      return {
        content: readContent(json),
        model: json.model || request.model,
        provider: request.provider || null,
        usage: json.usage || null,
        costUsd: readCost(json),
        latencyMs: Date.now() - startedAt,
        raw: json,
      };
    },
  };
}

export { buildProviderRoute };
