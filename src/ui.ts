/**
 * ui.ts – PolyPaste UI logic
 *
 * Runs inside the plugin iframe. Responsible for:
 *  - Rendering the three-tab interface (Translate / Results / Settings)
 *  - Handling user interactions
 *  - Orchestrating OpenAI translation calls (fetch runs here, not in the sandbox)
 *  - Displaying progress and QA results
 *
 * Communication:
 *   UI → Controller:  parent.postMessage({ pluginMessage: ... }, '*')
 *   Controller → UI:  window.onmessage → event.data.pluginMessage
 */
import {
  PluginSettings,
  DEFAULT_SETTINGS,
  UIMessage,
  ControllerMessage,
  ScanResult,
  TextEntry,
  QAReport,
  LangProgress,
  Language,
} from './types';
import { LANGUAGES, PRESETS, getLanguageByCode } from './lang';
import { translateBatch, shortenTranslations } from './translate';
import { testApiKey } from './openai';

// ────────────────────────────────────────────
// State
// ────────────────────────────────────────────
let settings: PluginSettings = { ...DEFAULT_SETTINGS };
let scanResult: ScanResult | null = null;
let selectedLangCodes: Set<string> = new Set();
let generating = false;
let abortController: AbortController | null = null;

/** Per-language progress, keyed by code. */
const langProgressMap = new Map<string, LangProgress>();

/** Stored translations per language (for rewrite-shorter). */
const translationsStore = new Map<string, Record<string, string>>();

/** Languages currently being rewritten. */
const rewritingLangs = new Set<string>();

/** Pending translation requests queued by the controller. */
const translationQueue: Array<{
  langCode: string;
  langName: string;
  isRTL: boolean;
  textEntries: TextEntry[];
  settings: PluginSettings;
}> = [];
let activeTranslations = 0;

// ────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────
function send(msg: UIMessage) {
  parent.postMessage({ pluginMessage: msg }, '*');
}

/** Query element by ID — named qid to avoid clashing with Figma globals. */
function qid(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) {
    console.warn('[PolyPaste] Missing element:', id);
    return document.createElement('div');
  }
  return el;
}

function $$<T extends HTMLElement>(sel: string, root: HTMLElement | Document = document): T[] {
  return Array.from(root.querySelectorAll<T>(sel));
}

function show(el: HTMLElement) { el.hidden = false; el.classList.remove('hidden'); }
function hide(el: HTMLElement) { el.hidden = true; el.classList.add('hidden'); }

// ────────────────────────────────────────────
// Initialisation
// ────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  // Request settings + initial scan from controller
  send({ type: 'init' });

  // ── Tabs ──
  for (const btn of $$<HTMLButtonElement>('.tab-btn')) {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab!));
  }

  // ── Translate tab ──
  qid('btn-rescan').addEventListener('click', () => send({ type: 'scan-selection' }));
  qid('lang-search').addEventListener('input', renderLanguageList);
  for (const btn of $$<HTMLButtonElement>('.preset-btn')) {
    btn.addEventListener('click', () => applyPreset(btn.dataset.preset!));
  }

  // ── Action buttons ──
  qid('btn-generate').addEventListener('click', () => startGeneration());
  qid('btn-cancel').addEventListener('click', cancelGeneration);
  qid('btn-go-translate').addEventListener('click', () => switchTab('translate'));

  // ── Settings tab: OpenAI ──
  qid('api-key-input').addEventListener('change', (e: Event) => {
    settings.apiKey = (e.target as HTMLInputElement).value.trim();
    persistSettings();
  });
  qid('model-input').addEventListener('change', (e: Event) => {
    settings.model = (e.target as HTMLInputElement).value.trim() || 'gpt-4o-mini';
    persistSettings();
  });
  qid('btn-test-key').addEventListener('click', handleTestKey);

  // ── Settings tab: Translation ──
  qid('tone-select').addEventListener('change', (e: Event) => {
    settings.tone = (e.target as HTMLSelectElement).value as PluginSettings['tone'];
    persistSettings();
  });
  qid('formality-select').addEventListener('change', (e: Event) => {
    settings.formality = (e.target as HTMLSelectElement).value as PluginSettings['formality'];
    persistSettings();
  });
  qid('translation-length').addEventListener('change', (e: Event) => {
    const val = (e.target as HTMLSelectElement).value as PluginSettings['translationLength'];
    applyTranslationLength(val);
    persistSettings();
  });
  wireToggle('preserve-line-breaks', 'preserveLineBreaks');
  wireToggle('preserve-placeholders', 'preservePlaceholders');
  wireToggle('skip-code-like', 'skipCodeLike');

  // Preserve terms
  qid('add-term-btn').addEventListener('click', addPreserveTerm);
  qid('term-input').addEventListener('keydown', (e: Event) => {
    if ((e as KeyboardEvent).key === 'Enter') addPreserveTerm();
  });

  // ── Settings tab: Layout ──
  for (const btn of $$<HTMLButtonElement>('.layout-btn')) {
    btn.addEventListener('click', () => {
      settings.layoutMode = btn.dataset.mode as PluginSettings['layoutMode'];
      renderLayoutButtons();
      persistSettings();
    });
  }
  qid('gap-input').addEventListener('change', (e: Event) => {
    settings.gap = parseInt((e.target as HTMLInputElement).value) || 80;
    persistSettings();
  });
  qid('wrap-cols-input').addEventListener('change', (e: Event) => {
    settings.wrapColumns = parseInt((e.target as HTMLInputElement).value) || 3;
    persistSettings();
  });
  wireToggle('show-labels', 'showLabels', () => renderLabelFormatState());
  qid('label-format').addEventListener('change', (e: Event) => {
    settings.labelFormat = (e.target as HTMLSelectElement).value as PluginSettings['labelFormat'];
    persistSettings();
  });

  // ── Settings tab: RTL ──
  wireToggle('auto-rtl', 'autoRTL', () => renderRTLSubOptions());
  wireToggle('set-direction-rtl', 'setDirectionRTL');
  wireToggle('mirror-layout', 'mirrorLayout');
  wireToggle('keep-western-numerals', 'keepWesternNumerals');
  wireToggle('keep-punctuation', 'keepPunctuationStyle');

  // ── Settings tab: Advanced ──
  wireToggle('allow-font-fallback', 'allowFontFallback');

  // ── Resize handle ──
  initResizeHandle();

  // ── Render initial state ──
  renderLanguageList();
  renderPresetButtons();
});

// ────────────────────────────────────────────
// Wire a toggle to a settings key
// ────────────────────────────────────────────
function wireToggle(elId: string, key: keyof PluginSettings, onChange?: () => void) {
  qid(elId).addEventListener('change', (e: Event) => {
    (settings as any)[key] = (e.target as HTMLInputElement).checked;
    persistSettings();
    if (onChange) onChange();
  });
}

function persistSettings() {
  send({ type: 'save-settings', settings });
}

// ────────────────────────────────────────────
// Translation length → derived settings
// ────────────────────────────────────────────
function applyTranslationLength(length: PluginSettings['translationLength']) {
  settings.translationLength = length;
  switch (length) {
    case 'strict':
      settings.maxExpansionRatio = 1.3;
      settings.keepShort = true;
      break;
    case 'normal':
      settings.maxExpansionRatio = 1.6;
      settings.keepShort = false;
      break;
    case 'relaxed':
      settings.maxExpansionRatio = 2.0;
      settings.keepShort = false;
      break;
  }
}

// ────────────────────────────────────────────
// Tabs
// ────────────────────────────────────────────
function switchTab(tab: string) {
  for (const btn of $$<HTMLButtonElement>('.tab-btn')) {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  }
  for (const panel of $$<HTMLElement>('.tab-content')) {
    panel.hidden = panel.id !== `tab-${tab}`;
  }
}

// ────────────────────────────────────────────
// Render: Selection card
// ────────────────────────────────────────────
function renderSelection() {
  if (!scanResult) {
    qid('selection-body').innerHTML = `
      <div class="no-selection">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="opacity: 0.4">
          <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"></path>
          <polyline points="13 2 13 9 20 9"></polyline>
        </svg>
        <span>Select a frame or instance to begin.</span>
      </div>
    `;
    return;
  }
  const s = scanResult;
  qid('selection-body').innerHTML = `
    <div class="selection-info">
      <span class="node-name" title="${esc(s.nodeName)}">${esc(s.nodeName)}</span>
      <span class="node-type">${esc(s.nodeType)}</span>
    </div>
    <div class="text-counts">
      <span>${s.translatableNodes} translatable</span>
      <span>${s.skippedEmpty} empty</span>
      <span>${s.skippedLocked} locked</span>
    </div>
  `;
}

// ────────────────────────────────────────────
// Render: Language list
// ────────────────────────────────────────────
function renderLanguageList() {
  const search = (qid('lang-search') as HTMLInputElement).value.toLowerCase();
  const container = qid('lang-list');
  container.innerHTML = '';

  const filtered = LANGUAGES.filter(l =>
    l.code !== 'en' && (
      l.name.toLowerCase().includes(search) ||
      l.nativeName.toLowerCase().includes(search) ||
      l.code.toLowerCase().includes(search)
    )
  );

  for (const lang of filtered) {
    const checked = selectedLangCodes.has(lang.code);
    const item = document.createElement('label');
    item.className = 'check-item';
    item.innerHTML = `
      <input type="checkbox" value="${lang.code}" ${checked ? 'checked' : ''}>
      <span>${esc(lang.name)}</span>
      <span class="native">${esc(lang.nativeName)}</span>
      <span class="code">${lang.code}</span>
    `;
    item.querySelector('input')!.addEventListener('change', (e: Event) => {
      const cb = e.target as HTMLInputElement;
      if (cb.checked) selectedLangCodes.add(lang.code);
      else selectedLangCodes.delete(lang.code);
      settings.selectedLanguages = [...selectedLangCodes];
      persistSettings();
      renderPresetButtons();
      renderSelectedCount();
    });
    container.appendChild(item);
  }
  renderSelectedCount();
}

function renderSelectedCount() {
  qid('selected-count').textContent = `${selectedLangCodes.size} selected`;
}

function renderPresetButtons() {
  for (const btn of $$<HTMLButtonElement>('.preset-btn')) {
    const codes = PRESETS[btn.dataset.preset as keyof typeof PRESETS] || [];
    const allSelected = codes.every(c => selectedLangCodes.has(c));
    btn.classList.toggle('active', allSelected);
  }
}

function applyPreset(preset: string) {
  const codes = PRESETS[preset as keyof typeof PRESETS];
  if (!codes) return;

  if (preset === 'all') {
    if (codes.length > 8) {
      if (!confirm(`Select all ${codes.length} languages?`)) return;
    }
  }

  const allSelected = codes.every(c => selectedLangCodes.has(c));
  for (const c of codes) {
    if (allSelected) selectedLangCodes.delete(c);
    else selectedLangCodes.add(c);
  }

  settings.selectedLanguages = [...selectedLangCodes];
  persistSettings();
  renderLanguageList();
  renderPresetButtons();
}

// ────────────────────────────────────────────
// Render: Layout buttons
// ────────────────────────────────────────────
function renderLayoutButtons() {
  for (const btn of $$<HTMLButtonElement>('.layout-btn')) {
    btn.classList.toggle('active', btn.dataset.mode === settings.layoutMode);
  }
  qid('wrap-cols-row').hidden = settings.layoutMode !== 'wrap';
}

// ────────────────────────────────────────────
// Render: Label format state
// ────────────────────────────────────────────
function renderLabelFormatState() {
  const row = qid('label-format-row');
  const select = qid('label-format') as HTMLSelectElement;
  if (settings.showLabels) {
    row.style.opacity = '';
    row.style.pointerEvents = '';
    select.disabled = false;
  } else {
    row.style.opacity = '0.4';
    row.style.pointerEvents = 'none';
    select.disabled = true;
  }
}

// ────────────────────────────────────────────
// Render: RTL sub-options
// ────────────────────────────────────────────
function renderRTLSubOptions() {
  const el = qid('rtl-sub-options');
  // When auto RTL is on, hide manual sub-options (auto handles it).
  // When off, show them (manual control).
  if (!settings.autoRTL) {
    show(el);
  } else {
    hide(el);
  }
}

// ────────────────────────────────────────────
// Render: Settings tab values
// ────────────────────────────────────────────
function renderSettingsValues() {
  (qid('api-key-input') as HTMLInputElement).value = settings.apiKey;
  (qid('model-input') as HTMLInputElement).value = settings.model;
  (qid('tone-select') as HTMLSelectElement).value = settings.tone;
  (qid('formality-select') as HTMLSelectElement).value = settings.formality;
  (qid('translation-length') as HTMLSelectElement).value = settings.translationLength || 'normal';

  setToggle('preserve-line-breaks', settings.preserveLineBreaks);
  setToggle('preserve-placeholders', settings.preservePlaceholders);
  setToggle('skip-code-like', settings.skipCodeLike);
  setToggle('allow-font-fallback', settings.allowFontFallback);
  setToggle('auto-rtl', settings.autoRTL);
  setToggle('set-direction-rtl', settings.setDirectionRTL);
  setToggle('mirror-layout', settings.mirrorLayout);
  setToggle('keep-western-numerals', settings.keepWesternNumerals);
  setToggle('keep-punctuation', settings.keepPunctuationStyle);
  setToggle('show-labels', settings.showLabels);
  (qid('label-format') as HTMLSelectElement).value = settings.labelFormat;
  (qid('gap-input') as HTMLInputElement).value = String(settings.gap);
  (qid('wrap-cols-input') as HTMLInputElement).value = String(settings.wrapColumns);

  renderPreserveTerms();
  renderLayoutButtons();
  renderLabelFormatState();
  renderRTLSubOptions();
}

function setToggle(id: string, value: boolean) {
  (qid(id) as HTMLInputElement).checked = value;
}

// ────────────────────────────────────────────
// Preserve terms
// ────────────────────────────────────────────
function addPreserveTerm() {
  const input = qid('term-input') as HTMLInputElement;
  const term = input.value.trim();
  if (!term) return;
  if (!settings.preserveTerms.includes(term)) {
    settings.preserveTerms.push(term);
    persistSettings();
  }
  input.value = '';
  renderPreserveTerms();
}

function removePreserveTerm(term: string) {
  settings.preserveTerms = settings.preserveTerms.filter(t => t !== term);
  persistSettings();
  renderPreserveTerms();
}

function renderPreserveTerms() {
  const container = qid('terms-list');
  container.innerHTML = '';
  for (const term of settings.preserveTerms) {
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.innerHTML = `${esc(term)} <button data-term="${esc(term)}">&times;</button>`;
    tag.querySelector('button')!.addEventListener('click', () => removePreserveTerm(term));
    container.appendChild(tag);
  }
}

// ────────────────────────────────────────────
// Test API key
// ────────────────────────────────────────────
async function handleTestKey() {
  const btn = qid('btn-test-key') as HTMLButtonElement;
  const status = qid('key-test-status');
  if (!settings.apiKey) {
    status.textContent = 'Enter an API key first.';
    status.className = 'text-xs';
    status.style.color = 'var(--danger)';
    return;
  }
  btn.disabled = true;
  status.textContent = 'Testing…';
  status.className = 'text-xs text-muted';
  status.style.color = '';

  const res = await testApiKey(settings.apiKey, settings.model);
  btn.disabled = false;
  if (res.ok) {
    status.textContent = 'Key is valid.';
    status.className = 'text-xs success-text';
    status.style.color = '';
  } else {
    status.textContent = res.error || 'Invalid key.';
    status.className = 'text-xs';
    status.style.color = 'var(--danger)';
  }
}

// ────────────────────────────────────────────
// Generation
// ────────────────────────────────────────────
function startGeneration() {
  if (generating) return;
  if (!scanResult || scanResult.translatableNodes === 0) {
    showError('No translatable text. Scan first.');
    return;
  }
  if (selectedLangCodes.size === 0) {
    showError('Select at least one language.');
    return;
  }
  if (!settings.apiKey) {
    showError('Set your OpenAI API key in Settings.');
    return;
  }

  if (selectedLangCodes.size > 8) {
    if (!confirm(`Generate for ${selectedLangCodes.size} languages?`)) return;
  }

  generating = true;
  abortController = new AbortController();
  langProgressMap.clear();
  translationsStore.clear();
  translationQueue.length = 0;
  activeTranslations = 0;
  hideError();

  const languages: Language[] = [];
  for (const code of selectedLangCodes) {
    const lang = getLanguageByCode(code);
    if (lang) languages.push(lang);
  }

  for (const lang of languages) {
    langProgressMap.set(lang.code, {
      langCode: lang.code,
      langName: lang.name,
      status: 'pending',
    });
  }

  // Switch to Results tab
  switchTab('results');
  hide(qid('results-empty'));
  show(qid('results-content'));
  renderStatusList();
  showGeneratingUI();

  send({ type: 'start-generate', languages, settings });
}

function cancelGeneration() {
  if (!generating) return;

  // Signal cancellation everywhere
  send({ type: 'cancel' });
  abortController?.abort();

  // Clear pending queue
  translationQueue.length = 0;

  // Mark all non-finished languages as cancelled
  for (const [, prog] of langProgressMap) {
    if (prog.status !== 'done' && prog.status !== 'error') {
      prog.status = 'cancelled';
    }
  }
  renderStatusList();

  generating = false;
  showIdleUI();
}

// ────────────────────────────────────────────
// Translation orchestration (runs here in the UI)
// ────────────────────────────────────────────
function enqueueTranslation(req: {
  langCode: string;
  langName: string;
  isRTL: boolean;
  textEntries: TextEntry[];
  settings: PluginSettings;
}) {
  if (!generating) return; // Ignore if cancelled
  translationQueue.push(req);
  processQueue();
}

async function processQueue() {
  while (
    generating &&
    translationQueue.length > 0 &&
    activeTranslations < 2
  ) {
    const req = translationQueue.shift()!;
    activeTranslations++;
    processTranslation(req).finally(() => {
      activeTranslations--;
      if (generating) processQueue();
    });
  }
}

async function processTranslation(req: {
  langCode: string;
  langName: string;
  isRTL: boolean;
  textEntries: TextEntry[];
  settings: PluginSettings;
}) {
  if (!generating) return;

  const { langCode, langName, isRTL, textEntries } = req;

  updateLangProgress(langCode, 'translating');

  const { translations, error } = await translateBatch(
    langName,
    langCode,
    isRTL,
    textEntries,
    req.settings,
    2,
    abortController?.signal,
  );

  if (!generating) return; // Cancelled while translating

  if (translations) {
    translationsStore.set(langCode, translations);
    send({ type: 'translations-ready', langCode, translations });
  } else {
    send({ type: 'translation-error', langCode, error: error || 'Unknown error' });
  }
}

// ────────────────────────────────────────────
// Status list rendering (Results tab)
// ────────────────────────────────────────────
function updateLangProgress(langCode: string, status: LangProgress['status'], detail?: string, qaReport?: QAReport) {
  const existing = langProgressMap.get(langCode);
  if (existing) {
    existing.status = status;
    if (detail !== undefined) existing.detail = detail;
    if (qaReport !== undefined) existing.qaReport = qaReport;
  }
  renderStatusList();
}

function renderStatusList() {
  const container = qid('status-list');
  if (langProgressMap.size === 0) {
    container.innerHTML = '';
    return;
  }

  let html = '';
  for (const [, prog] of langProgressMap) {
    html += renderStatusItem(prog);
  }
  container.innerHTML = html;

  // Wire rewrite-shorter buttons
  for (const btn of $$<HTMLButtonElement>('.rewrite-btn', container)) {
    btn.addEventListener('click', () => {
      const langCode = btn.dataset.lang;
      if (langCode) triggerRewriteShorter(langCode);
    });
  }

  // Render the summary bar above the list
  renderResultsSummary();
}

function renderResultsSummary() {
  const el = qid('results-summary');

  // Count statuses from QA reports
  let greenCount = 0;
  let amberCount = 0;
  let redCount = 0;
  let hasAnyReport = false;
  let hasIssues = false;

  for (const [, prog] of langProgressMap) {
    if (!prog.qaReport) continue;
    hasAnyReport = true;
    if (prog.qaReport.status === 'green') greenCount++;
    else if (prog.qaReport.status === 'amber') amberCount++;
    else if (prog.qaReport.status === 'red') redCount++;
    if (prog.qaReport.issueEntryIds.length > 0) hasIssues = true;
  }

  if (!hasAnyReport) {
    hide(el);
    return;
  }

  show(el);
  el.innerHTML = `
    <div class="summary-lights">
      <div class="summary-light">
        <span class="summary-dot green"></span>
        <span class="summary-count">${greenCount}</span>
      </div>
      <div class="summary-light">
        <span class="summary-dot amber"></span>
        <span class="summary-count">${amberCount}</span>
      </div>
      <div class="summary-light">
        <span class="summary-dot red"></span>
        <span class="summary-count">${redCount}</span>
      </div>
    </div>
    ${hasIssues ? '<button class="btn btn-secondary btn-sm" id="btn-rewrite-all-inline">Rewrite all shorter</button>' : ''}
  `;

  const rewriteBtn = el.querySelector('#btn-rewrite-all-inline');
  if (rewriteBtn) {
    rewriteBtn.addEventListener('click', () => triggerRewriteAll());
  }
}

function renderStatusItem(prog: LangProgress): string {
  const indicator = renderIndicator(prog);
  const errorDetail = prog.status === 'error' && prog.detail
    ? `<div class="status-error">${esc(prog.detail)}</div>`
    : '';
  const issues = prog.qaReport ? renderIssuesSummary(prog.qaReport, prog.langCode) : '';

  return `
    <div class="status-item">
      <div class="status-row">
        ${indicator}
        <span class="lang-name">${esc(prog.langName)}</span>
        <span class="lang-code">${prog.langCode}</span>
      </div>
      ${errorDetail}
      ${issues}
    </div>
  `;
}

function renderIndicator(prog: LangProgress): string {
  switch (prog.status) {
    case 'pending':
      return '<span class="status-dot grey"></span>';
    case 'duplicating':
    case 'translating':
    case 'applying':
    case 'qa':
      return '<div class="spinner"></div>';
    case 'done': {
      if (prog.qaReport) {
        return `<span class="status-dot ${prog.qaReport.status}"></span>`;
      }
      return '<span class="status-dot green"></span>';
    }
    case 'error':
      return '<span class="status-dot red"></span>';
    case 'cancelled':
      return '<span class="status-dot grey"></span>';
    default:
      return '';
  }
}

function renderIssuesSummary(report: QAReport, langCode: string): string {
  const nonGreen = report.issues.filter(i => i.severity !== 'green');
  if (nonGreen.length === 0) return '';

  const overflows = nonGreen.filter(i => i.type === 'text-overflow' && i.severity === 'red').length;
  const lineWraps = nonGreen.filter(i => i.type === 'text-overflow' && i.severity === 'amber').length;
  const containerBreaks = nonGreen.filter(i => i.type === 'container-overflow').length;
  const fontErrors = nonGreen.filter(i => i.type === 'font-load').length;

  const parts: string[] = [];
  if (overflows > 0) parts.push(`${overflows} overflow`);
  if (lineWraps > 0) parts.push(`${lineWraps} new line${lineWraps > 1 ? 's' : ''}`);
  if (containerBreaks > 0) parts.push(`${containerBreaks} breaks container`);
  if (fontErrors > 0) parts.push(`${fontErrors} missing font${fontErrors > 1 ? 's' : ''}`);

  const summary = parts.join(', ');
  const hasLayoutIssues = overflows > 0 || lineWraps > 0 || containerBreaks > 0;
  const isRewriting = rewritingLangs.has(langCode);

  let html = `<div class="issues-inline">`;
  html += `<span class="issues-summary">${summary}</span>`;
  if (hasLayoutIssues && !isRewriting) {
    html += ` <button class="rewrite-btn" data-lang="${langCode}">Rewrite shorter</button>`;
  }
  if (isRewriting) {
    html += ` <span class="text-muted text-xs">Rewriting…</span>`;
  }
  html += `</div>`;

  return html;
}

// ────────────────────────────────────────────
// Rewrite shorter
// ────────────────────────────────────────────
async function triggerRewriteShorter(langCode: string) {
  const prog = langProgressMap.get(langCode);
  const storedTranslations = translationsStore.get(langCode);
  if (!prog?.qaReport || !storedTranslations || !scanResult) return;

  const issueIds = new Set(prog.qaReport.issueEntryIds || []);
  if (issueIds.size === 0) return;

  const entries: { id: string; original: string; current: string }[] = [];
  for (const te of scanResult.textEntries) {
    if (issueIds.has(te.id) && storedTranslations[te.id]) {
      entries.push({
        id: te.id,
        original: te.characters,
        current: storedTranslations[te.id],
      });
    }
  }
  if (entries.length === 0) return;

  // Mark as rewriting — stays in the set until the controller progress arrives
  rewritingLangs.add(langCode);
  updateLangProgress(langCode, 'applying');

  try {
    const { translations, error } = await shortenTranslations(
      prog.langName,
      entries,
      settings,
    );

    if (error || !translations) {
      send({ type: 'notify', message: error || 'Rewrite failed', error: true });
      rewritingLangs.delete(langCode);
      updateLangProgress(langCode, 'done');
      return;
    }

    const merged = { ...storedTranslations, ...translations };
    translationsStore.set(langCode, merged);

    // Controller applies + re-runs QA, then sends language-progress back
    send({ type: 'apply-rewrites', langCode, translations });
  } catch (_e) {
    send({ type: 'notify', message: 'Rewrite failed', error: true });
    rewritingLangs.delete(langCode);
    updateLangProgress(langCode, 'done');
  }
}

/** Rewrite all languages that have layout issues. */
async function triggerRewriteAll() {
  const langsWithIssues: string[] = [];
  for (const [code, prog] of langProgressMap) {
    if (prog.qaReport && prog.qaReport.issueEntryIds.length > 0) {
      langsWithIssues.push(code);
    }
  }
  // Run sequentially to avoid hammering the API
  for (const code of langsWithIssues) {
    await triggerRewriteShorter(code);
  }
}

// ────────────────────────────────────────────
// UI state: idle vs generating
// ────────────────────────────────────────────
function showGeneratingUI() {
  hide(qid('btn-generate'));
  show(qid('btn-cancel'));
}

function showIdleUI() {
  show(qid('btn-generate'));
  hide(qid('btn-cancel'));
}

function showError(msg: string) {
  const el = qid('error-banner');
  el.textContent = msg;
  show(el);
}

function hideError() {
  hide(qid('error-banner'));
}

// ────────────────────────────────────────────
// Message handler (from controller)
// ────────────────────────────────────────────
window.onmessage = (event) => {
  const msg = event.data?.pluginMessage as ControllerMessage;
  if (!msg) return;

  try { handleMessage(msg); } catch (err) {
    console.error('[PolyPaste] UI message error:', err);
  }
};

function handleMessage(msg: ControllerMessage) {
  switch (msg.type) {
    case 'init-complete': {
      settings = msg.settings;
      selectedLangCodes = new Set(settings.selectedLanguages || []);
      try { renderSettingsValues(); } catch (err) {
        console.error('[PolyPaste] renderSettingsValues error:', err);
      }
      renderLanguageList();
      renderPresetButtons();
      break;
    }

    case 'scan-result': {
      scanResult = msg.result;
      renderSelection();
      hideError();
      break;
    }

    case 'scan-error': {
      scanResult = null;
      renderSelection();
      showError(msg.error);
      break;
    }

    case 'selection-changed': {
      send({ type: 'scan-selection' });
      break;
    }

    case 'request-translation': {
      enqueueTranslation({
        langCode: msg.langCode,
        langName: msg.langName,
        isRTL: msg.isRTL,
        textEntries: msg.textEntries,
        settings: msg.settings,
      });
      break;
    }

    case 'language-progress': {
      const p = msg.progress;
      const isRewrite = rewritingLangs.has(p.langCode);
      // Accept during generation OR during rewrite-shorter
      if (!generating && !isRewrite) return;
      // If this is the final response after a rewrite, clear the flag
      if (isRewrite && (p.status === 'done' || p.status === 'error')) {
        rewritingLangs.delete(p.langCode);
      }
      updateLangProgress(p.langCode, p.status, p.detail, p.qaReport);
      break;
    }

    case 'all-complete': {
      generating = false;
      showIdleUI();
      const reports = msg.reports;
      const reds = reports.filter(r => r.status === 'red').length;
      const ambers = reports.filter(r => r.status === 'amber').length;

      // Summary bar already renders from renderStatusList
      if (reds > 0) {
        send({ type: 'notify', message: `Done. ${reds} language(s) have issues.`, error: true });
      } else if (ambers > 0) {
        send({ type: 'notify', message: `Done. ${ambers} language(s) have warnings.` });
      } else {
        send({ type: 'notify', message: 'Done. All languages passed QA.' });
      }
      break;
    }

    case 'error': {
      showError(msg.error);
      generating = false;
      showIdleUI();
      break;
    }

    case 'cancelled': {
      generating = false;
      showIdleUI();
      break;
    }
  }
}

// ────────────────────────────────────────────
// Resize handle
// ────────────────────────────────────────────
function initResizeHandle() {
  const handle = qid('resize-handle');
  let dragging = false;
  let startX = 0;
  let startY = 0;
  let startW = 0;
  let startH = 0;

  handle.addEventListener('pointerdown', (e: PointerEvent) => {
    dragging = true;
    startX = e.clientX;
    startY = e.clientY;
    startW = document.documentElement.clientWidth;
    startH = document.documentElement.clientHeight;
    handle.setPointerCapture(e.pointerId);
    e.preventDefault();
  });

  handle.addEventListener('pointermove', (e: PointerEvent) => {
    if (!dragging) return;
    const newW = Math.round(startW + (e.clientX - startX));
    const newH = Math.round(startH + (e.clientY - startY));
    send({ type: 'resize', width: newW, height: newH });
  });

  handle.addEventListener('pointerup', () => { dragging = false; });
  handle.addEventListener('lostpointercapture', () => { dragging = false; });
}

// ────────────────────────────────────────────
// Escape HTML
// ────────────────────────────────────────────
function esc(s: string): string {
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}
