# PolyPaste

PolyPaste duplicates selected Figma designs and translates their text into multiple languages using OpenAI, preserving original styles and component structures.

It automatically arranges these translated variations on the canvas with smart layout options and comprehensive Right-to-Left (RTL) mirroring for languages like Arabic and Hebrew.

A built-in Quality Assurance system monitors layout integrity, using a traffic-light interface to immediately flag text overflows, unexpected line breaks, or height changes.

Designers can resolve these layout issues directly within the plugin by triggering AI-powered rewrites to shorten specific translations or bulk-fix all errors.

The tool features a minimal, professional interface with secure API key storage, custom layout controls, and intelligent caching for a seamless production workflow.

## Features

- **Multi-language duplication** – Select a frame, instance, group, or section and generate translated copies side by side (Row, Wrap, or Column layout).
- **OpenAI translation** – Batch-translates all text nodes using the Chat Completions API with JSON response mode. Preserves placeholders, line breaks, and terms you mark as untranslatable.
- **AI Rewriting** – Automatically shorten translations that break the layout or rewrite all text to be more concise with a single click.
- **RTL first-class support** – Automatic paragraph direction, optional right-alignment, and horizontal auto-layout mirroring for Arabic, Hebrew, Persian, Urdu, and more.
- **QA traffic lights** – Real-time layout checks detect overflows, unexpected line breaks, and height changes. Each language gets a Green / Amber / Red badge.
- **Non-destructive** – Never detaches instances. Translations are applied as text overrides on cloned nodes. The original is never modified.
- **Swiss Design UI** – Clean, minimal interface with strict alignment, high contrast, and refined typography.

## Getting started

### Prerequisites

- [Node.js](https://nodejs.org/) 18+
- [Figma Desktop](https://www.figma.com/downloads/)

### Install and build

```bash
npm install
npm run build
```

### Load in Figma

1. Open Figma Desktop.
2. Go to **Plugins → Development → Import plugin from manifest…**
3. Select the `manifest.json` file in this directory.
4. The plugin appears under **Plugins → Development → PolyPaste**.

### Development

```bash
npm run watch
```

This watches `src/` for changes and rebuilds automatically. Reload the plugin in Figma after each rebuild (Cmd+Shift+P → "Run last plugin" or re-open PolyPaste).

## Usage

1. **Select** one frame, component instance, group, or section on the canvas.
2. Open PolyPaste.
3. **Set your OpenAI API key** in the Settings tab (stored locally via `figma.clientStorage`, never sent anywhere except OpenAI).
4. **Choose languages** using presets (Common, EU, RTL, All) or the search/checkbox list.
5. Configure layout (Row/Wrap/Column), gap, and label options.
6. Click **Translate** to duplicate + translate.
7. Watch per-language progress. QA badges appear when each language completes.
8. **Fix issues**: If a translation breaks the layout (Red/Amber), click "Rewrite shorter" to generate a more concise version, or use "Rewrite all shorter" to fix everything at once.

## Architecture

```
src/
├── types.ts       Shared TypeScript interfaces and message contracts
├── lang.ts        ISO language list, RTL mapping, presets
├── openai.ts      OpenAI Chat Completions API wrapper (runs in UI iframe)
├── translate.ts   Prompt builder, batch translation, retries, shortening logic
├── duplicate.ts   Node duplication, text mapping, placement, labels, font loading
├── qa.ts          Layout-break heuristics (overflow, height checks)
├── code.ts        Figma plugin controller (main-thread sandbox)
├── ui.ts          UI logic, state management, translation orchestration
├── ui.html        HTML template (CSS/JS inlined at build time)
└── ui.css         Swiss design system stylesheet
```

**Key architectural decisions:**

- **No framework** – Plain TypeScript + DOM manipulation keeps the bundle small (~50KB total) and fast.
- **esbuild** – Bundles both the sandbox controller and the UI script, then inlines CSS+JS into a single HTML file.
- **Fetch in the UI** – Figma's sandbox cannot call external URLs. All OpenAI requests happen in the UI iframe via `fetch`, with results passed to the controller via `postMessage`.
- **DFS text-node mapping** – After cloning, both the original and clone trees are walked in depth-first order. Text nodes at corresponding indices are mapped for translation application.

## Privacy and security

- **API key storage** – Your OpenAI key is stored locally via `figma.clientStorage` (Figma's per-plugin local storage). It is never logged, exposed in the UI (masked password field), or sent to any server other than `api.openai.com`.
- **Network access** – The plugin only communicates with `https://api.openai.com`. This is declared in `manifest.json` under `networkAccess.allowedDomains`.
- **No telemetry** – PolyPaste does not collect analytics, crash reports, or usage data of any kind.
- **Text sent to OpenAI** – The text content of your Figma layers is sent to the OpenAI API for translation. Review your organization's data policies before translating sensitive content.

## License

MIT
