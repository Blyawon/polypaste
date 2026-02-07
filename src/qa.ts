/**
 * qa.ts – Layout-based QA checks
 *
 * Runs in Figma's sandbox AFTER translations are applied to cloned nodes.
 * Compares the translated text node dimensions to the original to detect:
 *
 *  1. Line wrap   — translated text wraps to more lines than the original  → amber
 *  2. Overflow    — text doesn't fit in a fixed-size container             → red
 *  3. Container   — node extends beyond a fixed-size ancestor frame        → red
 *  4. Font errors — font couldn't be loaded                                → amber
 */
import { TextEntry, QAIssue, QAReport, Language, Severity } from './types';

// ────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────

export function runQA(
  textNodeMap: Map<string, TextNode>,
  originalEntries: TextEntry[],
  language: Language,
  fontErrors: string[],
): QAReport {
  const issues: QAIssue[] = [];
  const issueEntryIds = new Set<string>();

  const originalMap = new Map<string, TextEntry>();
  for (const entry of originalEntries) {
    originalMap.set(entry.id, entry);
  }

  for (const [id, textNode] of textNodeMap) {
    if (!textNode.parent) continue;

    const original = originalMap.get(id);
    if (!original) continue;

    const origHeight = original.height;
    const lineHeight = (original.lineHeight && original.lineHeight > 0)
      ? original.lineHeight
      : original.fontSize * 1.4;
    const resize = textNode.textAutoResize;

    // ── Check 1: Overflow in fixed-size text box (NONE mode) ──
    // The text box has a fixed height that can't grow. Measure if text needs more.
    if (resize === 'NONE') {
      const neededHeight = measureNeededHeight(textNode);
      const fixedHeight = textNode.height;
      if (neededHeight > fixedHeight + 0.5) {
        issueEntryIds.add(id);
        issues.push({
          severity: 'red',
          type: 'text-overflow',
          nodeId: textNode.id,
          nodeName: textNode.name,
          message: 'Overflow',
        });
        continue; // Skip further checks for this node
      }
    }

    // ── Check 2: Line wrap (HEIGHT mode only) ──
    // Width is fixed, height auto-adjusts. If height grew by at least one
    // full line compared to the original, the translated text wrapped.
    // Skip WIDTH_AND_HEIGHT — those auto-expand horizontally, no overflow possible.
    if (resize === 'HEIGHT') {
      const currentHeight = textNode.height; // already auto-adjusted for translated text
      const heightDelta = currentHeight - origHeight;
      // Require at least ~1 full line of growth, with a minimum 4px floor
      const threshold = Math.max(lineHeight * 0.8, 4);
      if (heightDelta > threshold) {
        const extraLines = Math.max(1, Math.round(heightDelta / lineHeight));
        issueEntryIds.add(id);
        issues.push({
          severity: 'amber',
          type: 'text-overflow',
          nodeId: textNode.id,
          nodeName: textNode.name,
          message: extraLines === 1 ? 'New line' : `+${extraLines} lines`,
        });
      }
    }

    // ── Check 3: Breaks a fixed-size ancestor frame ──
    // This catches ALL resize modes — if a node visually exceeds its parent.
    const parentCheck = checkParentOverflow(textNode);
    if (parentCheck.overflows) {
      issueEntryIds.add(id);
      issues.push({
        severity: 'red',
        type: 'container-overflow',
        nodeId: textNode.id,
        nodeName: textNode.name,
        message: 'Breaks container',
      });
    }
  }

  // ── Check 4: Font errors ──
  for (const fontErr of fontErrors) {
    issues.push({
      severity: 'amber',
      type: 'font-load',
      nodeId: '',
      nodeName: '',
      message: 'Missing font',
    });
  }

  const redCount = issues.filter(i => i.severity === 'red').length;
  const amberCount = issues.filter(i => i.severity === 'amber').length;
  let status: Severity = 'green';
  if (redCount > 0) status = 'red';
  else if (amberCount > 0) status = 'amber';

  return {
    langCode: language.code,
    langName: language.name,
    status,
    issues,
    issueEntryIds: [...issueEntryIds],
    amberIssues: amberCount,
    redIssues: redCount,
  };
}

// ────────────────────────────────────────────
// Measurements
// ────────────────────────────────────────────

/**
 * Measure the actual height the text needs inside a fixed-size text box.
 *
 * Temporarily switches to HEIGHT auto-resize (width stays fixed, height
 * adjusts to fit), reads the resulting height, then restores NONE + the
 * original dimensions. Only called for NONE-mode nodes.
 *
 * Runs on CLONED nodes, never on the user's originals.
 */
function measureNeededHeight(textNode: TextNode): number {
  const origWidth = textNode.width;
  const origHeight = textNode.height;
  const origResize = textNode.textAutoResize;

  // If already in HEIGHT mode, the current height IS the needed height
  if (origResize === 'HEIGHT') {
    return textNode.height;
  }

  // WIDTH_AND_HEIGHT: width also auto-adjusts, but we want to
  // measure at the CURRENT width to detect line wrapping.
  // NONE: height is fixed, we need to unlock it to measure.

  try {
    textNode.textAutoResize = 'HEIGHT';
    const neededHeight = textNode.height;

    // Restore original state
    textNode.textAutoResize = origResize as 'NONE' | 'WIDTH_AND_HEIGHT' | 'HEIGHT' | 'TRUNCATE';
    if (origResize === 'NONE' || origResize === 'TRUNCATE') {
      textNode.resize(origWidth, origHeight);
    }

    return neededHeight;
  } catch (_e) {
    // Best-effort restore
    try {
      textNode.textAutoResize = origResize as 'NONE' | 'WIDTH_AND_HEIGHT' | 'HEIGHT' | 'TRUNCATE';
      if (origResize === 'NONE' || origResize === 'TRUNCATE') {
        textNode.resize(origWidth, origHeight);
      }
    } catch (_e2) { /* swallow */ }

    return origHeight; // Assume no change on failure
  }
}

// ────────────────────────────────────────────
// Parent overflow
// ────────────────────────────────────────────

/**
 * Walk up the tree and check if the node extends beyond any
 * ancestor frame that has fixed dimensions (would cause clipping
 * or layout breakage in a real UI).
 *
 * Checks both auto-layout frames with FIXED sizing modes
 * and regular frames (which always have fixed dimensions).
 */
function checkParentOverflow(node: SceneNode): { overflows: boolean; parentName: string } {
  const nodeBounds = node.absoluteBoundingBox;
  if (!nodeBounds) return { overflows: false, parentName: '' };

  let current: BaseNode | null = node.parent;
  while (current && current.type !== 'PAGE' && current.type !== 'DOCUMENT') {
    if (isFrameLike(current)) {
      const frame = current as FrameNode;
      const fb = frame.absoluteBoundingBox;
      if (fb) {
        const T = 1; // 1px tolerance for float rounding only
        const overflowH = nodeBounds.x + nodeBounds.width > fb.x + fb.width + T;
        const overflowV = nodeBounds.y + nodeBounds.height > fb.y + fb.height + T;

        if (overflowH && isFixedOnAxis(frame, 'horizontal')) {
          return { overflows: true, parentName: frame.name };
        }
        if (overflowV && isFixedOnAxis(frame, 'vertical')) {
          return { overflows: true, parentName: frame.name };
        }
      }
    }
    current = current.parent;
  }

  return { overflows: false, parentName: '' };
}

function isFrameLike(node: BaseNode): boolean {
  return node.type === 'FRAME' || node.type === 'COMPONENT' || node.type === 'INSTANCE';
}

/**
 * Determine if a frame has a fixed size on the given axis.
 *
 * - Non-auto-layout frames: always fixed on both axes.
 * - Auto-layout frames: check primaryAxisSizingMode / counterAxisSizingMode.
 *   Primary axis depends on layoutMode (HORIZONTAL → width, VERTICAL → height).
 */
function isFixedOnAxis(frame: FrameNode, axis: 'horizontal' | 'vertical'): boolean {
  const lm = frame.layoutMode;
  // No auto-layout → both axes are fixed
  if (!lm || lm === 'NONE') return true;

  if (lm === 'HORIZONTAL') {
    // Primary axis = horizontal, counter axis = vertical
    if (axis === 'horizontal') return frame.primaryAxisSizingMode === 'FIXED';
    return frame.counterAxisSizingMode === 'FIXED';
  } else {
    // VERTICAL: primary = vertical, counter = horizontal
    if (axis === 'vertical') return frame.primaryAxisSizingMode === 'FIXED';
    return frame.counterAxisSizingMode === 'FIXED';
  }
}
