/**
 * translate.ts – Translation payload builder, batching, and retries
 *
 * Runs in the UI iframe alongside openai.ts.
 */
import { callOpenAI, OpenAIResponse } from './openai';
import { TextEntry, PluginSettings } from './types';

// ── System prompt (kept terse – token-efficient) ──
const SYSTEM_PROMPT =
  'You are a professional UI translator. You MUST respond with valid json only — no markdown, no explanation, no prose. Output a single json object mapping each id to its translated string.';

// ────────────────────────────────────────────
// Prompt builder
// ────────────────────────────────────────────
export function buildTranslationPrompt(
  targetName: string,
  targetCode: string,
  isRTL: boolean,
  entries: TextEntry[],
  settings: PluginSettings,
): string {
  const strings: Record<string, { text: string; context: string }> = {};
  for (const e of entries) {
    strings[e.id] = { text: e.characters, context: e.nodeName };
  }

  const payload = {
    sourceLanguage: 'auto',
    targetLanguage: `${targetName} (${targetCode})`,
    isRTL,
    rules: {
      keepShort: settings.keepShort,
      maxExpansionRatio: settings.maxExpansionRatio,
      tone: settings.tone,
      formality: settings.formality,
      preserveLineBreaks: settings.preserveLineBreaks,
      preservePlaceholders: settings.preservePlaceholders,
      keepWesternNumerals: settings.keepWesternNumerals,
      keepPunctuationStyle: settings.keepPunctuationStyle,
      preserveTerms: settings.preserveTerms,
    },
    strings,
  };

  return [
    'Translate the following UI strings and return the result as json.',
    '',
    'Input:',
    JSON.stringify(payload, null, 2),
    '',
    'Expected output format (json):',
    '{ "<id>": "translated text", ... }',
    '',
    'Rules:',
    '- Respond with json only — no markdown fences, no explanation.',
    '- Do not translate preserveTerms.',
    '- Keep placeholders exactly unchanged: {name}, {{name}}, %s, %d, URLs, {0}, etc.',
    '- If keepShort is true and expansion exceeds maxExpansionRatio, shorten while keeping meaning.',
    '- Keep Western numerals if keepWesternNumerals is true.',
    '- Preserve punctuation style if keepPunctuationStyle is true.',
    '- Preserve line breaks if preserveLineBreaks is true.',
  ].join('\n');
}

// ────────────────────────────────────────────
// Batch translate one language
// ────────────────────────────────────────────
export interface TranslateResult {
  translations: Record<string, string> | null;
  error: string | null;
}

/**
 * Translate all text entries for a single target language.
 * Retries on transient errors (rate limit, JSON parse).
 */
export async function translateBatch(
  langName: string,
  langCode: string,
  isRTL: boolean,
  entries: TextEntry[],
  settings: PluginSettings,
  maxRetries: number = 2,
  signal?: AbortSignal,
): Promise<TranslateResult> {
  const prompt = buildTranslationPrompt(langName, langCode, isRTL, entries, settings);
  let lastError = '';

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    // Honour cancellation
    if (signal?.aborted) return { translations: null, error: 'Cancelled.' };

    // On retries, add an extra strictness note
    const extra =
      attempt > 0
        ? '\n\nIMPORTANT: Return ONLY valid JSON. No markdown fences, no explanation.'
        : '';

    const response: OpenAIResponse = await callOpenAI({
      apiKey: settings.apiKey,
      model: settings.model,
      systemPrompt: SYSTEM_PROMPT + extra,
      userPrompt: prompt,
      temperature: 0.2,
      signal,
    });

    if (!response.ok) {
      lastError = response.error || 'Unknown error';
      // Hard-fail on auth error
      if (response.status === 401) return { translations: null, error: lastError };
      // Back-off on rate limit
      if (response.status === 429) {
        await delay(2000 * (attempt + 1));
        continue;
      }
      continue;
    }

    // Validate shape
    const data = response.data;
    if (!data || typeof data !== 'object') {
      lastError = 'Invalid response format from OpenAI.';
      continue;
    }

    // Extract translations, tolerating extra keys
    const translations: Record<string, string> = {};
    let valid = 0;
    for (const entry of entries) {
      const val = (data as Record<string, unknown>)[entry.id];
      if (typeof val === 'string') {
        translations[entry.id] = val;
        valid++;
      }
    }

    if (valid === 0) {
      lastError = 'No valid translations in response.';
      continue;
    }

    return { translations, error: null };
  }

  return { translations: null, error: lastError };
}

// ────────────────────────────────────────────
// Rewrite shorter – called when QA detects layout issues
// ────────────────────────────────────────────

/**
 * Takes problematic translations and asks OpenAI to rewrite them shorter.
 * `entries` should only contain the items that have layout issues.
 */
export async function shortenTranslations(
  langName: string,
  entries: { id: string; original: string; current: string }[],
  settings: PluginSettings,
  signal?: AbortSignal,
): Promise<TranslateResult> {
  if (entries.length === 0) return { translations: {}, error: null };

  const payload: Record<string, { original: string; current: string }> = {};
  for (const e of entries) {
    payload[e.id] = { original: e.original, current: e.current };
  }

  const systemPrompt =
    'You are a professional UI translator. Rewrite translations to be as short as possible while keeping the same meaning. Respond with valid json only.';

  const userPrompt = [
    `These ${langName} translations are too long for their UI containers.`,
    'Rewrite each one SHORTER while keeping the exact same meaning.',
    'Return json only: { "<id>": "shorter text", ... }',
    '',
    JSON.stringify(payload, null, 2),
  ].join('\n');

  const response = await callOpenAI({
    apiKey: settings.apiKey,
    model: settings.model,
    systemPrompt,
    userPrompt,
    temperature: 0.3,
    signal,
  });

  if (!response.ok) {
    return { translations: null, error: response.error || 'Failed to shorten' };
  }

  const data = response.data;
  if (!data || typeof data !== 'object') {
    return { translations: null, error: 'Invalid response' };
  }

  const result: Record<string, string> = {};
  for (const entry of entries) {
    const val = (data as Record<string, unknown>)[entry.id];
    if (typeof val === 'string') {
      result[entry.id] = val;
    }
  }

  return { translations: result, error: null };
}

// ── Util ──
function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
