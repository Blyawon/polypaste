/**
 * types.ts – Shared type definitions for PolyPaste
 *
 * Every message between the UI iframe and the Figma controller is typed here.
 * Settings, scan results, QA reports, and language models live here too.
 */

// ────────────────────────────────────────────
// Language
// ────────────────────────────────────────────
export interface Language {
  code: string;        // ISO 639-1 (e.g. "ar")
  name: string;        // English name
  nativeName: string;  // Native script
  isRTL: boolean;
}

export type LanguagePreset = 'common' | 'eu' | 'rtl' | 'all';

// ────────────────────────────────────────────
// Settings (persisted via figma.clientStorage)
// ────────────────────────────────────────────
export interface PluginSettings {
  // OpenAI
  apiKey: string;
  model: string;

  // Translation rules
  tone: 'neutral' | 'friendly' | 'formal';
  formality: 'auto' | 'formal' | 'informal';
  translationLength: 'strict' | 'normal' | 'relaxed';
  keepShort: boolean;
  maxExpansionRatio: number;
  preserveTerms: string[];
  preserveLineBreaks: boolean;
  preservePlaceholders: boolean;
  skipCodeLike: boolean;

  // Layout
  layoutMode: 'row' | 'wrap' | 'column';
  gap: number;
  wrapColumns: number;
  showLabels: boolean;
  labelFormat: 'iso' | 'english' | 'native';

  // RTL
  autoRTL: boolean;
  setDirectionRTL: boolean;
  mirrorLayout: boolean;
  keepWesternNumerals: boolean;
  keepPunctuationStyle: boolean;

  // Text fitting
  allowFontFallback: boolean;

  // Persisted language selections
  selectedLanguages: string[];
}

export const DEFAULT_SETTINGS: PluginSettings = {
  apiKey: '',
  model: 'gpt-4o-mini',

  tone: 'neutral',
  formality: 'auto',
  translationLength: 'normal',
  keepShort: false,
  maxExpansionRatio: 1.6,
  preserveTerms: [],
  preserveLineBreaks: true,
  preservePlaceholders: true,
  skipCodeLike: true,

  layoutMode: 'row',
  gap: 80,
  wrapColumns: 3,
  showLabels: true,
  labelFormat: 'english',

  autoRTL: true,
  setDirectionRTL: true,
  mirrorLayout: false,
  keepWesternNumerals: true,
  keepPunctuationStyle: true,

  allowFontFallback: true,

  selectedLanguages: [],
};

// ────────────────────────────────────────────
// Scan result
// ────────────────────────────────────────────
export interface TextEntry {
  /** Stable key for mapping (e.g. "t0", "t1") */
  id: string;
  /** Figma node ID */
  nodeId: string;
  /** Layer name in Figma */
  nodeName: string;
  /** The raw text content */
  characters: string;
  /** Resolved font size (first range if mixed) */
  fontSize: number;
  /** Bounding width in px */
  width: number;
  /** Bounding height in px */
  height: number;
  /** NONE | WIDTH_AND_HEIGHT | HEIGHT */
  textAutoResize: string;
  /** LEFT | CENTER | RIGHT | JUSTIFIED */
  textAlignHorizontal: string;
  /** Heuristic: likely a UI label */
  isLabelLike: boolean;
  /** Resolved line height in px */
  lineHeight: number;
  /** "family:style" (first range if mixed) */
  fontName: string;
}

export interface ScanResult {
  nodeName: string;
  nodeType: string;
  nodeId: string;
  totalTextNodes: number;
  translatableNodes: number;
  skippedEmpty: number;
  skippedLocked: number;
  textEntries: TextEntry[];
}

// ────────────────────────────────────────────
// QA
// ────────────────────────────────────────────
export type Severity = 'green' | 'amber' | 'red';

export type IssueType =
  | 'text-overflow'
  | 'container-overflow'
  | 'font-load';

export interface QAIssue {
  severity: Severity;
  type: IssueType;
  nodeId: string;
  nodeName: string;
  message: string;
}

export interface QAReport {
  langCode: string;
  langName: string;
  status: Severity;
  issues: QAIssue[];
  /** Entry IDs (e.g. "t0") that have layout issues — used for rewrite-shorter. */
  issueEntryIds: string[];
  amberIssues: number;
  redIssues: number;
}

// ────────────────────────────────────────────
// Language progress tracking
// ────────────────────────────────────────────
export type LangStatus =
  | 'pending'
  | 'duplicating'
  | 'translating'
  | 'applying'
  | 'qa'
  | 'done'
  | 'error'
  | 'cancelled';

export interface LangProgress {
  langCode: string;
  langName: string;
  status: LangStatus;
  detail?: string;
  qaReport?: QAReport;
}

// ────────────────────────────────────────────
// Messages: UI → Controller
// ────────────────────────────────────────────
export type UIMessage =
  | { type: 'init' }
  | { type: 'scan-selection' }
  | { type: 'start-generate'; languages: Language[]; settings: PluginSettings }
  | { type: 'translations-ready'; langCode: string; translations: Record<string, string> }
  | { type: 'translation-error'; langCode: string; error: string }
  | { type: 'apply-rewrites'; langCode: string; translations: Record<string, string> }
  | { type: 'cancel' }
  | { type: 'save-settings'; settings: Partial<PluginSettings> }
  | { type: 'resize'; width: number; height: number }
  | { type: 'notify'; message: string; error?: boolean };

// ────────────────────────────────────────────
// Messages: Controller → UI
// ────────────────────────────────────────────
export type ControllerMessage =
  | { type: 'init-complete'; settings: PluginSettings }
  | { type: 'scan-result'; result: ScanResult }
  | { type: 'scan-error'; error: string }
  | {
      type: 'request-translation';
      langCode: string;
      langName: string;
      isRTL: boolean;
      textEntries: TextEntry[];
      settings: PluginSettings;
    }
  | { type: 'language-progress'; progress: LangProgress }
  | { type: 'all-complete'; reports: QAReport[] }
  | { type: 'error'; error: string }
  | { type: 'cancelled' }
  | { type: 'selection-changed' };
