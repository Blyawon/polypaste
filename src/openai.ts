/**
 * openai.ts – Thin wrapper around OpenAI Chat Completions API
 *
 * Runs inside the UI iframe (which has fetch access).
 * The controller sandbox cannot call external URLs.
 *
 * We use /v1/chat/completions with response_format: json_object
 * to guarantee parseable JSON output.
 */

export interface OpenAIRequestOptions {
  apiKey: string;
  model: string;
  systemPrompt: string;
  userPrompt: string;
  temperature?: number;
  /** When true (default), sends response_format: json_object. Set false for non-JSON calls. */
  jsonMode?: boolean;
  /** AbortSignal for cancellation support. */
  signal?: AbortSignal;
}

export interface OpenAIResponse {
  ok: boolean;
  data?: Record<string, unknown>;
  error?: string;
  status?: number;
}

/**
 * Call OpenAI and return parsed JSON.
 * Never logs or exposes the API key beyond the Authorization header.
 */
export async function callOpenAI(opts: OpenAIRequestOptions): Promise<OpenAIResponse> {
  const { apiKey, model, systemPrompt, userPrompt, temperature = 0.2, jsonMode = true, signal } = opts;

  try {
    const body: Record<string, unknown> = {
      model,
      temperature,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    };

    // Only request structured JSON output when caller needs it
    if (jsonMode) {
      body.response_format = { type: 'json_object' };
    }

    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal,
    });

    if (!res.ok) {
      const text = await res.text().catch((_e: unknown) => '');
      if (res.status === 401) return { ok: false, error: 'Invalid API key (401).', status: 401 };
      if (res.status === 429) return { ok: false, error: 'Rate limited (429). Wait and retry.', status: 429 };
      return { ok: false, error: `OpenAI ${res.status}: ${text.slice(0, 200)}`, status: res.status };
    }

    const json = await res.json();
    const content: string | undefined = json.choices?.[0]?.message?.content;
    if (!content) return { ok: false, error: 'Empty response from OpenAI.' };

    // In non-JSON mode, return raw content string under a "text" key
    if (!jsonMode) {
      return { ok: true, data: { text: content } };
    }

    const parsed = JSON.parse(content);
    return { ok: true, data: parsed };
  } catch (e: unknown) {
    if (e instanceof SyntaxError) {
      return { ok: false, error: 'Failed to parse JSON from OpenAI response.' };
    }
    const msg = e instanceof Error ? e.message : 'Network error.';
    return { ok: false, error: msg };
  }
}

/**
 * Quick key validation – makes a trivial request to confirm the key works.
 */
export async function testApiKey(apiKey: string, model: string): Promise<OpenAIResponse> {
  return callOpenAI({
    apiKey,
    model,
    systemPrompt: 'Reply with the single word OK.',
    userPrompt: 'Ping',
    temperature: 0,
    jsonMode: false,
  });
}
