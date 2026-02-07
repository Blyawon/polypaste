/**
 * code.ts – PolyPaste Figma plugin controller
 *
 * Runs in Figma's main-thread sandbox. Has access to the document tree
 * but NOT to fetch/network. All OpenAI calls happen in the UI iframe.
 *
 * Communication:
 *   UI → Controller:  figma.ui.onmessage   (UIMessage)
 *   Controller → UI:  figma.ui.postMessage  (ControllerMessage)
 */
import {
  PluginSettings,
  DEFAULT_SETTINGS,
  UIMessage,
  ControllerMessage,
  TextEntry,
  Language,
  QAReport,
} from './types';
import {
  scanTextNodes,
  duplicateAndPlace,
  addLabel,
  applyTranslations,
  mirrorAutoLayout,
} from './duplicate';
import { runQA } from './qa';

// ────────────────────────────────────────────
// State
// ────────────────────────────────────────────
let settings: PluginSettings = { ...DEFAULT_SETTINGS };
let cancelled = false;
let originalEntries: TextEntry[] = [];

/** Per-language clone data, keyed by language code. */
const cloneMap = new Map<
  string,
  { clone: SceneNode; textNodeMap: Map<string, TextNode> }
>();

/** Language objects stored during generation so we can look them up later. */
const languageMap = new Map<string, Language>();

/** QA reports collected during generation. */
const qaReports: QAReport[] = [];

/** Number of languages still pending (for all-complete detection). */
let pendingCount = 0;

// ────────────────────────────────────────────
// Show UI
// ────────────────────────────────────────────
figma.showUI(__html__, { width: 400, height: 660, themeColors: true });

// ────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────
function send(msg: ControllerMessage) {
  figma.ui.postMessage(msg);
}

async function loadSettings(): Promise<PluginSettings> {
  try {
    const stored = await figma.clientStorage.getAsync('polypaste-settings');
    return stored ? { ...DEFAULT_SETTINGS, ...stored } : { ...DEFAULT_SETTINGS };
  } catch (_e) {
    console.error('[PolyPaste] loadSettings failed:', _e);
    return { ...DEFAULT_SETTINGS };
  }
}

async function saveSettings(partial: Partial<PluginSettings>) {
  settings = { ...settings, ...partial };
  try {
    await figma.clientStorage.setAsync('polypaste-settings', settings);
  } catch (_e) {
    console.error('[PolyPaste] saveSettings failed:', _e);
  }
}

/** Validate that exactly one supported node is selected. */
function validateSelection(): SceneNode | null {
  const sel = figma.currentPage.selection;
  if (sel.length !== 1) return null;
  const node = sel[0];
  const valid = ['INSTANCE', 'FRAME', 'GROUP', 'SECTION', 'COMPONENT'];
  return valid.includes(node.type) ? node : null;
}

/** Perform a scan and send the result to the UI. */
function performScan(): boolean {
  const node = validateSelection();
  if (!node) {
    send({ type: 'scan-error', error: 'Select one frame, instance, group, or section.' });
    return false;
  }
  const { entries, totalTextNodes, skippedEmpty, skippedLocked } = scanTextNodes(node);
  originalEntries = entries;
  send({
    type: 'scan-result',
    result: {
      nodeName: node.name,
      nodeType: node.type,
      nodeId: node.id,
      totalTextNodes,
      translatableNodes: entries.length,
      skippedEmpty,
      skippedLocked,
      textEntries: entries,
    },
  });
  return true;
}

// ────────────────────────────────────────────
// Message handler
// ────────────────────────────────────────────
figma.ui.onmessage = async (msg: UIMessage) => {
  switch (msg.type) {
    // ── Initialise ──────────────────────────
    case 'init': {
      settings = await loadSettings();
      send({ type: 'init-complete', settings });
      // Auto-scan if there is a valid selection
      performScan();
      break;
    }

    // ── Manual rescan ───────────────────────
    case 'scan-selection': {
      performScan();
      break;
    }

    // ── Start generation ────────────────────
    case 'start-generate': {
      cancelled = false;
      cloneMap.clear();
      languageMap.clear();
      qaReports.length = 0;

      const node = validateSelection();
      if (!node) {
        send({ type: 'error', error: 'Selection lost. Select a node and rescan.' });
        return;
      }

      const { languages, settings: incoming } = msg;
      settings = incoming;
      await saveSettings(incoming);

      // Store languages for later lookup
      for (const lang of languages) languageMap.set(lang.code, lang);

      if (originalEntries.length === 0) {
        send({ type: 'error', error: 'No translatable text found. Rescan first.' });
        return;
      }

      // Pre-load label font
      if (settings.showLabels) {
        try { await figma.loadFontAsync({ family: 'Inter', style: 'Regular' }); }
        catch (_e) { /* labels may fail, non-critical */ }
      }

      // ── Duplicate for each language ──
      for (let i = 0; i < languages.length; i++) {
        if (cancelled) { send({ type: 'cancelled' }); return; }

        const lang = languages[i];
        send({
          type: 'language-progress',
          progress: { langCode: lang.code, langName: lang.name, status: 'duplicating' },
        });

        const { clone, textNodeMap } = duplicateAndPlace(
          node, i, lang, settings, originalEntries,
        );
        cloneMap.set(lang.code, { clone, textNodeMap });

        // Optional label
        if (settings.showLabels) {
          try { addLabel(clone, lang, settings); } catch (_e) { /* non-critical */ }
        }

        // RTL mirror
        if (lang.isRTL && settings.autoRTL && settings.mirrorLayout) {
          const mirrored = mirrorAutoLayout(clone);
          if (!mirrored) {
            send({
              type: 'language-progress',
              progress: {
                langCode: lang.code,
                langName: lang.name,
                status: 'duplicating',
                detail: 'Mirroring skipped (layout not compatible)',
              },
            });
          }
        }
      }

      // ── Request translations from the UI (one message per language) ──
      pendingCount = languages.length;
      for (const lang of languages) {
        if (cancelled) { send({ type: 'cancelled' }); return; }
        send({
          type: 'language-progress',
          progress: { langCode: lang.code, langName: lang.name, status: 'translating' },
        });
        send({
          type: 'request-translation',
          langCode: lang.code,
          langName: lang.name,
          isRTL: lang.isRTL,
          textEntries: originalEntries,
          settings,
        });
      }
      break;
    }

    // ── Translations arrived from UI ────────
    case 'translations-ready': {
      if (cancelled) return;
      const { langCode, translations } = msg;
      const entry = cloneMap.get(langCode);
      const language = languageMap.get(langCode);
      if (!entry || !language) {
        send({ type: 'error', error: `Internal: no clone for ${langCode}.` });
        return;
      }

      // Apply phase
      send({
        type: 'language-progress',
        progress: { langCode, langName: language.name, status: 'applying' },
      });

      const { fontErrors } = await applyTranslations(
        entry.textNodeMap,
        translations,
        language,
        settings,
      );

      // QA — measure actual Figma layout for overflow
      send({
        type: 'language-progress',
        progress: { langCode, langName: language.name, status: 'qa' },
      });
      const qaReport = runQA(entry.textNodeMap, originalEntries, language, fontErrors);
      qaReports.push(qaReport);

      send({
        type: 'language-progress',
        progress: {
          langCode,
          langName: language.name,
          status: 'done',
          qaReport,
        },
      });

      // Check if all languages are done
      pendingCount--;
      if (pendingCount <= 0) {
        send({ type: 'all-complete', reports: qaReports });
      }
      break;
    }

    // ── Translation error from UI ───────────
    case 'translation-error': {
      if (cancelled) { pendingCount--; return; }
      const { langCode, error } = msg;
      const language = languageMap.get(langCode);
      send({
        type: 'language-progress',
        progress: {
          langCode,
          langName: language?.name || langCode,
          status: 'error',
          detail: error,
        },
      });

      pendingCount--;
      if (pendingCount <= 0) {
        send({ type: 'all-complete', reports: qaReports });
      }
      break;
    }

    // ── Rewrite shorter (post-QA fix) ──────
    case 'apply-rewrites': {
      const { langCode, translations } = msg;
      const entry = cloneMap.get(langCode);
      const language = languageMap.get(langCode);
      if (!entry || !language) {
        send({ type: 'error', error: `No clone for ${langCode}.` });
        return;
      }

      send({
        type: 'language-progress',
        progress: { langCode, langName: language.name, status: 'applying' },
      });

      const { fontErrors } = await applyTranslations(
        entry.textNodeMap, translations, language, settings,
      );

      const qaReport = runQA(entry.textNodeMap, originalEntries, language, fontErrors);

      send({
        type: 'language-progress',
        progress: { langCode, langName: language.name, status: 'done', qaReport },
      });
      break;
    }

    // ── Cancel ──────────────────────────────
    case 'cancel': {
      cancelled = true;
      send({ type: 'cancelled' });
      break;
    }

    // ── Save settings ───────────────────────
    case 'save-settings': {
      await saveSettings(msg.settings);
      break;
    }

    // ── Resize UI ────────────────────────────
    case 'resize': {
      const w = Math.max(300, Math.min(800, msg.width));
      const h = Math.max(400, Math.min(1200, msg.height));
      figma.ui.resize(w, h);
      break;
    }

    // ── Notifications ───────────────────────
    case 'notify': {
      figma.notify(msg.message, { error: !!msg.error });
      break;
    }
  }
};

// ── Selection change → tell UI ──
figma.on('selectionchange', () => {
  send({ type: 'selection-changed' });
});
