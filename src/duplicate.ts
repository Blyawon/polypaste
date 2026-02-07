/**
 * duplicate.ts – Node duplication, text-node mapping, placement, labels
 *
 * Runs in the Figma controller (has access to figma.* API).
 */
import { Language, PluginSettings, TextEntry } from './types';

// ────────────────────────────────────────────
// Scanning
// ────────────────────────────────────────────

/** Walk up the parent chain looking for a locked node. */
function isInLockedChain(node: SceneNode): boolean {
  let current: BaseNode | null = node;
  while (current && 'locked' in current) {
    if ((current as SceneNode).locked) return true;
    current = current.parent;
  }
  return false;
}

/** Heuristic: is this text node likely a short UI label? */
function isLabelLike(node: TextNode): boolean {
  const name = node.name.toLowerCase();
  const keywords = [
    'label', 'button', 'cta', 'chip', 'tab', 'badge',
    'nav', 'btn', 'link', 'title', 'heading', 'tag',
  ];
  if (keywords.some(kw => name.includes(kw))) return true;

  const fontSize = typeof node.fontSize === 'number' ? node.fontSize : 14;
  if (fontSize <= 14 && node.characters.length <= 24) return true;

  return false;
}

/** Resolve a numeric line-height (px) from the Figma type. */
function resolveLineHeight(node: TextNode): number {
  const lh = node.lineHeight;
  const fallbackFs = typeof node.fontSize === 'number' ? node.fontSize : 14;
  if (lh === figma.mixed) return fallbackFs * 1.2;
  if (typeof lh === 'object') {
    if (lh.unit === 'PIXELS') return lh.value;
    if (lh.unit === 'PERCENT') return fallbackFs * (lh.value / 100);
  }
  return fallbackFs * 1.2; // AUTO
}

/** "family:style" string for the first font range. */
function fontNameStr(node: TextNode): string {
  const fn = node.fontName;
  if (fn === figma.mixed) {
    const first = node.getRangeFontName(0, 1) as FontName;
    return `${first.family}:${first.style}`;
  }
  return `${fn.family}:${fn.style}`;
}

/**
 * Scan a selection recursively and collect translatable TextEntry objects.
 */
export function scanTextNodes(root: SceneNode): {
  entries: TextEntry[];
  totalTextNodes: number;
  skippedEmpty: number;
  skippedLocked: number;
} {
  const entries: TextEntry[] = [];
  let totalTextNodes = 0;
  let skippedEmpty = 0;
  let skippedLocked = 0;
  let idx = 0;

  function walk(node: SceneNode) {
    if (node.type === 'TEXT') {
      totalTextNodes++;
      const tn = node as TextNode;

      if (!tn.characters.trim()) { skippedEmpty++; return; }
      if (isInLockedChain(tn)) { skippedLocked++; return; }

      const fs = typeof tn.fontSize === 'number' ? tn.fontSize : 14;
      entries.push({
        id: `t${idx++}`,
        nodeId: tn.id,
        nodeName: tn.name,
        characters: tn.characters,
        fontSize: fs,
        width: tn.width,
        height: tn.height,
        textAutoResize: tn.textAutoResize,
        textAlignHorizontal: tn.textAlignHorizontal,
        isLabelLike: isLabelLike(tn),
        lineHeight: resolveLineHeight(tn),
        fontName: fontNameStr(tn),
      });
    }

    if ('children' in node) {
      for (const child of (node as ChildrenMixin).children) {
        walk(child as SceneNode);
      }
    }
  }

  walk(root);
  return { entries, totalTextNodes, skippedEmpty, skippedLocked };
}

// ────────────────────────────────────────────
// Collecting text nodes (DFS order)
// ────────────────────────────────────────────
function collectTextNodes(node: SceneNode): TextNode[] {
  const result: TextNode[] = [];
  function walk(n: SceneNode) {
    if (n.type === 'TEXT') result.push(n as TextNode);
    if ('children' in n) {
      for (const child of (n as ChildrenMixin).children) {
        walk(child as SceneNode);
      }
    }
  }
  walk(node);
  return result;
}

// ────────────────────────────────────────────
// Duplication + placement
// ────────────────────────────────────────────

/**
 * Clone the original node, place it according to layout settings,
 * and return a mapping from stable text IDs → cloned TextNode references.
 */
export function duplicateAndPlace(
  original: SceneNode,
  langIndex: number,
  language: Language,
  settings: PluginSettings,
  originalEntries: TextEntry[],
): { clone: SceneNode; textNodeMap: Map<string, TextNode> } {
  const clone = original.clone();
  clone.name = `${original.name} – ${language.name} (${language.code})`;

  // ── Position ──
  const { layoutMode, gap, wrapColumns } = settings;
  switch (layoutMode) {
    case 'row':
      clone.x = original.x + (langIndex + 1) * (original.width + gap);
      clone.y = original.y;
      break;
    case 'column':
      clone.x = original.x;
      clone.y = original.y + (langIndex + 1) * (original.height + gap);
      break;
    case 'wrap': {
      const col = langIndex % wrapColumns;
      const row = Math.floor(langIndex / wrapColumns);
      clone.x = original.x + (col + 1) * (original.width + gap);
      clone.y = original.y + row * (original.height + gap);
      break;
    }
  }

  // ── Build text-node map ──
  // Both trees have identical structure, so DFS index alignment is stable.
  const textNodeMap = new Map<string, TextNode>();
  const origTexts = collectTextNodes(original);
  const cloneTexts = collectTextNodes(clone);

  for (let i = 0; i < origTexts.length && i < cloneTexts.length; i++) {
    const entry = originalEntries.find(e => e.nodeId === origTexts[i].id);
    if (entry) {
      textNodeMap.set(entry.id, cloneTexts[i]);
    }
  }

  // ── Append to same parent ──
  const parent = original.parent;
  if (parent && 'appendChild' in parent) {
    (parent as ChildrenMixin).appendChild(clone);
  }

  return { clone, textNodeMap };
}

// ────────────────────────────────────────────
// Labels
// ────────────────────────────────────────────

/**
 * Create a language label text node above the clone.
 * Requires Inter Regular to be pre-loaded (caller must handle).
 */
export function addLabel(
  clone: SceneNode,
  language: Language,
  settings: PluginSettings,
): void {
  const { labelFormat } = settings;

  let text = language.code;
  if (labelFormat === 'english') text = `${language.code} / ${language.name}`;
  if (labelFormat === 'native') text = `${language.code} / ${language.nativeName}`;

  const label = figma.createText();
  label.fontName = { family: 'Inter', style: 'Regular' };
  label.characters = text;
  label.fontSize = 11;
  label.fills = [{ type: 'SOLID', color: { r: 0.5, g: 0.5, b: 0.5 } }];
  label.name = `_polypaste_label_${language.code}`;

  label.y = clone.y - 20;
  label.x = clone.x;

  const parent = clone.parent;
  if (parent && 'appendChild' in parent) {
    (parent as ChildrenMixin).appendChild(label);
  }
}

// ────────────────────────────────────────────
// Font loading
// ────────────────────────────────────────────

/** Load all fonts used by a TextNode (handles mixed-font ranges). */
export async function loadFontsForNode(node: TextNode): Promise<boolean> {
  try {
    if (node.fontName === figma.mixed) {
      const loaded = new Set<string>();
      for (let i = 0; i < node.characters.length; i++) {
        const fn = node.getRangeFontName(i, i + 1) as FontName;
        const key = `${fn.family}:${fn.style}`;
        if (!loaded.has(key)) {
          loaded.add(key);
          await figma.loadFontAsync(fn);
        }
      }
    } else {
      await figma.loadFontAsync(node.fontName);
    }
    return true;
  } catch (_e) {
    return false;
  }
}

/** Try a list of common fallback fonts. */
export async function applyFallbackFont(node: TextNode): Promise<boolean> {
  const fallbacks: FontName[] = [
    { family: 'Inter', style: 'Regular' },
    { family: 'Roboto', style: 'Regular' },
    { family: 'Arial', style: 'Regular' },
  ];
  for (const font of fallbacks) {
    try {
      await figma.loadFontAsync(font);
      node.fontName = font;
      return true;
    } catch (_e) { continue; }
  }
  return false;
}

// ────────────────────────────────────────────
// Apply translations
// ────────────────────────────────────────────

/**
 * Write translated strings into cloned text nodes.
 * Handles font loading, RTL direction, and alignment.
 */
export async function applyTranslations(
  textNodeMap: Map<string, TextNode>,
  translations: Record<string, string>,
  language: Language,
  settings: PluginSettings,
): Promise<{ applied: number; fontErrors: string[] }> {
  let applied = 0;
  const fontErrors: string[] = [];

  for (const [id, translation] of Object.entries(translations)) {
    const node = textNodeMap.get(id);
    if (!node) continue;

    // Load fonts
    let ok = await loadFontsForNode(node);
    if (!ok) {
      if (settings.allowFontFallback) ok = await applyFallbackFont(node);
      if (!ok) { fontErrors.push(node.name); continue; }
    }

    // Set text
    node.characters = translation;
    applied++;

    // ── RTL handling ──
    if (language.isRTL && settings.autoRTL) {
      // Paragraph direction (may not exist in all API versions)
      if (settings.setDirectionRTL) {
        try {
          // @ts-expect-error – paragraphDirection not in all typings
          node.paragraphDirection = 'RTL';
        } catch (_e) { /* graceful fallback */ }
      }

      // RTL text must be right-aligned, unless it's centered
      if (node.textAlignHorizontal !== 'CENTER') {
        node.textAlignHorizontal = 'RIGHT';
      }
    }
  }

  return { applied, fontErrors };
}

// ────────────────────────────────────────────
// RTL mirror (auto-layout only)
// ────────────────────────────────────────────

/**
 * Reverse children order of horizontal auto-layout frames.
 * Returns true if mirroring was applied; false if not compatible.
 */
export function mirrorAutoLayout(node: SceneNode): boolean {
  if (
    node.type !== 'FRAME' &&
    node.type !== 'COMPONENT' &&
    node.type !== 'INSTANCE'
  ) {
    return false;
  }

  const frame = node as FrameNode;
  if (frame.layoutMode !== 'HORIZONTAL') return false;

  try {
    const kids = [...frame.children];
    for (let i = kids.length - 1; i >= 0; i--) {
      frame.appendChild(kids[i]);
    }
    return true;
  } catch (_e) {
    return false;
  }
}
