/**
 * lang.ts – ISO language list, RTL mapping, and presets
 *
 * Each entry carries an isRTL flag so the rest of the plugin can reason
 * about directionality without an extra lookup.
 */
import { Language, LanguagePreset } from './types';

export const LANGUAGES: Language[] = [
  // ── Common ──
  { code: 'en',    name: 'English',                nativeName: 'English',            isRTL: false },
  { code: 'es',    name: 'Spanish',                nativeName: 'Español',            isRTL: false },
  { code: 'fr',    name: 'French',                 nativeName: 'Français',           isRTL: false },
  { code: 'de',    name: 'German',                 nativeName: 'Deutsch',            isRTL: false },
  { code: 'it',    name: 'Italian',                nativeName: 'Italiano',           isRTL: false },
  { code: 'pt',    name: 'Portuguese',             nativeName: 'Português',          isRTL: false },
  { code: 'pt-BR', name: 'Portuguese (Brazil)',    nativeName: 'Português (Brasil)', isRTL: false },
  { code: 'nl',    name: 'Dutch',                  nativeName: 'Nederlands',         isRTL: false },
  { code: 'ru',    name: 'Russian',                nativeName: 'Русский',            isRTL: false },
  { code: 'zh-CN', name: 'Chinese (Simplified)',   nativeName: '简体中文',            isRTL: false },
  { code: 'zh-TW', name: 'Chinese (Traditional)',  nativeName: '繁體中文',            isRTL: false },
  { code: 'ja',    name: 'Japanese',               nativeName: '日本語',              isRTL: false },
  { code: 'ko',    name: 'Korean',                 nativeName: '한국어',              isRTL: false },

  // ── EU official languages (not already above) ──
  { code: 'bg',    name: 'Bulgarian',              nativeName: 'Български',          isRTL: false },
  { code: 'cs',    name: 'Czech',                  nativeName: 'Čeština',            isRTL: false },
  { code: 'da',    name: 'Danish',                 nativeName: 'Dansk',              isRTL: false },
  { code: 'el',    name: 'Greek',                  nativeName: 'Ελληνικά',           isRTL: false },
  { code: 'et',    name: 'Estonian',               nativeName: 'Eesti',              isRTL: false },
  { code: 'fi',    name: 'Finnish',                nativeName: 'Suomi',              isRTL: false },
  { code: 'ga',    name: 'Irish',                  nativeName: 'Gaeilge',            isRTL: false },
  { code: 'hr',    name: 'Croatian',               nativeName: 'Hrvatski',           isRTL: false },
  { code: 'hu',    name: 'Hungarian',              nativeName: 'Magyar',             isRTL: false },
  { code: 'lt',    name: 'Lithuanian',             nativeName: 'Lietuvių',           isRTL: false },
  { code: 'lv',    name: 'Latvian',                nativeName: 'Latviešu',           isRTL: false },
  { code: 'mt',    name: 'Maltese',                nativeName: 'Malti',              isRTL: false },
  { code: 'pl',    name: 'Polish',                 nativeName: 'Polski',             isRTL: false },
  { code: 'ro',    name: 'Romanian',               nativeName: 'Română',             isRTL: false },
  { code: 'sk',    name: 'Slovak',                 nativeName: 'Slovenčina',         isRTL: false },
  { code: 'sl',    name: 'Slovenian',              nativeName: 'Slovenščina',        isRTL: false },
  { code: 'sv',    name: 'Swedish',                nativeName: 'Svenska',            isRTL: false },

  // ── RTL ──
  { code: 'ar',    name: 'Arabic',                 nativeName: 'العربية',             isRTL: true },
  { code: 'he',    name: 'Hebrew',                 nativeName: 'עברית',              isRTL: true },
  { code: 'fa',    name: 'Persian',                nativeName: 'فارسی',              isRTL: true },
  { code: 'ur',    name: 'Urdu',                   nativeName: 'اردو',               isRTL: true },
  { code: 'yi',    name: 'Yiddish',                nativeName: 'ייִדיש',              isRTL: true },
  { code: 'ps',    name: 'Pashto',                 nativeName: 'پښتو',               isRTL: true },
  { code: 'ku',    name: 'Kurdish (Sorani)',        nativeName: 'کوردی',              isRTL: true },

  // ── Other popular ──
  { code: 'hi',    name: 'Hindi',                  nativeName: 'हिन्दी',               isRTL: false },
  { code: 'bn',    name: 'Bengali',                nativeName: 'বাংলা',               isRTL: false },
  { code: 'ta',    name: 'Tamil',                  nativeName: 'தமிழ்',               isRTL: false },
  { code: 'te',    name: 'Telugu',                 nativeName: 'తెలుగు',              isRTL: false },
  { code: 'th',    name: 'Thai',                   nativeName: 'ไทย',                isRTL: false },
  { code: 'vi',    name: 'Vietnamese',             nativeName: 'Tiếng Việt',         isRTL: false },
  { code: 'id',    name: 'Indonesian',             nativeName: 'Bahasa Indonesia',   isRTL: false },
  { code: 'ms',    name: 'Malay',                  nativeName: 'Bahasa Melayu',      isRTL: false },
  { code: 'tr',    name: 'Turkish',                nativeName: 'Türkçe',             isRTL: false },
  { code: 'uk',    name: 'Ukrainian',              nativeName: 'Українська',         isRTL: false },
  { code: 'no',    name: 'Norwegian',              nativeName: 'Norsk',              isRTL: false },
  { code: 'sw',    name: 'Swahili',                nativeName: 'Kiswahili',          isRTL: false },
  { code: 'tl',    name: 'Filipino',               nativeName: 'Filipino',           isRTL: false },
  { code: 'ca',    name: 'Catalan',                nativeName: 'Català',             isRTL: false },
  { code: 'af',    name: 'Afrikaans',              nativeName: 'Afrikaans',          isRTL: false },
];

/** Look up a Language object by ISO code. */
export function getLanguageByCode(code: string): Language | undefined {
  return LANGUAGES.find(l => l.code === code);
}

// ── Presets ──
export const PRESETS: Record<LanguagePreset, string[]> = {
  common: ['es', 'fr', 'de', 'it', 'pt', 'nl', 'ru', 'zh-CN', 'ja', 'ko'],
  eu: [
    'bg', 'cs', 'da', 'de', 'el', 'es', 'et', 'fi', 'fr', 'ga',
    'hr', 'hu', 'it', 'lt', 'lv', 'mt', 'nl', 'pl', 'pt', 'ro',
    'sk', 'sl', 'sv',
  ],
  rtl: ['ar', 'he', 'fa', 'ur'],
  all: LANGUAGES.filter(l => l.code !== 'en').map(l => l.code),
};

