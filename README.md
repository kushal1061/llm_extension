# LLM Extension

A Chrome extension (Manifest V3) that intercepts prompts typed in ChatGPT and routes each request either to:

- a **local Ollama model** (`ministral-3:8b`), or
- **ChatGPT pass-through** (default site behavior),

using a two-layer semantic routing pipeline.

---

## Table of Contents

- [Overview](#overview)
- [How It Works](#how-it-works)
  - [Layer 1: Keyword + Intent Detection](#layer-1-keyword--intent-detection)
  - [Layer 2: LLM Category Classifier](#layer-2-llm-category-classifier)
  - [Final Routing Decision](#final-routing-decision)
- [Project Structure](#project-structure)
- [Requirements](#requirements)
- [Installation](#installation)
- [Usage](#usage)
- [Routing Rules Summary](#routing-rules-summary)
- [Behavior Notes](#behavior-notes)
- [Configuration Points](#configuration-points)
- [Troubleshooting](#troubleshooting)
- [Limitations](#limitations)
- [Security and Privacy Notes](#security-and-privacy-notes)
- [Future Improvements](#future-improvements)

---

## Overview

This extension injects a content script into ChatGPT conversation pages and listens for **Enter** key submission in the prompt editor.

When a user submits a query:

1. The extension classifies intent quickly using regex rules.
2. If intent is ambiguous, it asks a local Ollama model to classify category/confidence.
3. It routes to:
   - **Local model** for suitable tasks (math/coding/general/creative/reasoning, etc.), or
   - **ChatGPT** for real-time/web/tool/long-context style tasks.

For local routes, it streams the response and injects a custom response bubble into the ChatGPT DOM.

---

## How It Works

### Layer 1: Keyword + Intent Detection

`keywordRoute(query)` applies fast regex rules (`ROUTING_RULES`) with no network call.

- Returns one of: `local`, `chatgpt`, `unknown`
- Includes matched category and marks `layer: 1`

Examples:

- Local triggers: `calculate`, `debug`, `explain`, `write a`, `compare`
- ChatGPT triggers: `today`, `latest`, `search the web`, `image`, `upload`, `full codebase`

### Layer 2: LLM Category Classifier

If Layer 1 returns `unknown`, `llmCategoryRoute(query)` sends a classification prompt to:

- `http://localhost:11434/api/generate`
- model: `ministral-3:8b`

Expected JSON response:

```json
{"category": "<category>", "confidence": 0.0}
```

The category is mapped to `local` or `chatgpt` using allowlists:

- `LOCAL_CATEGORIES`
- `CHATGPT_CATEGORIES`

### Final Routing Decision

`semanticRoute(query)` combines both layers:

- If Layer 1 returns direct route → use it immediately
- Else invoke Layer 2
- If LLM confidence is below threshold (`CONFIDENCE_THRESHOLD = 0.65`) → fallback to `chatgpt`

---

## Project Structure

```text
.
├── content.js      # Main routing, streaming, DOM injection, and key listeners
└── manifest.json   # Chrome extension manifest (MV3)
```

---

## Requirements

- Google Chrome (or Chromium-based browser with extension support)
- Local Ollama instance running at `http://localhost:11434`
- Ollama model available: `ministral-3:8b`
- Access to `https://chatgpt.com/c/*`

---

## Installation

1. Clone the repository.
2. Ensure Ollama is running locally:
   - install/start Ollama
   - pull model: `ministral-3:8b`
3. Open Chrome and go to `chrome://extensions`.
4. Enable **Developer mode**.
5. Click **Load unpacked** and select this repository folder.
6. Open a ChatGPT conversation URL matching: `https://chatgpt.com/c/*`.

If loaded correctly, browser console will show:

```text
✅ Extension loaded
```

---

## Usage

1. Open an existing/new ChatGPT conversation page.
2. Type your prompt in the ChatGPT editor.
3. Press **Enter**.
4. The extension intercepts the submission and decides route:
   - **Local route**:
     - query sent to Ollama
     - streamed tokens rendered in a custom bubble
     - badge shows category/layer/confidence (if Layer 2)
   - **ChatGPT route**:
     - prompt is re-inserted and submitted to ChatGPT automatically

Notes:

- `Shift + Enter` remains available for multiline input.
- Concurrency is controlled via `isProcessing` to avoid overlapping requests.

---

## Routing Rules Summary

### Forced Local (Layer 1)

- `math`
- `coding`
- `general`
- `creative`
- `reasoning`

### Forced ChatGPT (Layer 1)

- `realtime`
- `web`
- `longctx`

### LLM-Based Categories (Layer 2)

Local-friendly:

- `math`
- `coding`
- `general_knowledge`
- `creative_writing`
- `reasoning`
- `language`
- `summarization`
- `translation`

ChatGPT/Internet/tool-oriented:

- `realtime_info`
- `web_search`
- `image_generation`
- `file_analysis`
- `long_context`
- `specialized_tool`

---

## Behavior Notes

- Streaming parser handles line-delimited JSON chunks from Ollama.
- Unparseable stream lines are skipped with a warning.
- Any fatal error during local flow falls back to ChatGPT submission.
- Local response bubble is appended to the latest assistant section in DOM.

---

## Configuration Points

Inside `content.js`, common knobs include:

- `ROUTING_RULES` regex patterns
- `CONFIDENCE_THRESHOLD`
- `LOCAL_CATEGORIES` / `CHATGPT_CATEGORIES`
- Ollama endpoint and model name in:
  - `llmCategoryRoute()`
  - `getLocalStreamingResponse()`

---

## Troubleshooting

### Extension does not trigger

- Confirm URL matches `https://chatgpt.com/c/*`
- Verify extension is enabled in `chrome://extensions`
- Check DevTools console for content script logs

### Local route never works

- Ensure Ollama is running on `localhost:11434`
- Confirm `ministral-3:8b` is installed locally
- Check for fetch/network errors in browser console

### Query always goes to ChatGPT

- Your query may match a forced ChatGPT keyword rule
- Layer 2 classifier confidence may be below threshold (`0.65`)
- Classifier JSON parse failures force fallback behavior

---

## Limitations

- Target match is limited to `https://chatgpt.com/c/*` (not homepage/new URL variants).
- DOM selectors are tightly coupled to current ChatGPT UI structure.
- No popup/options UI for runtime configuration.
- No persistence/analytics or debug panel.
- No automated test suite in repository yet.

---

## Security and Privacy Notes

- Prompts routed locally are sent to Ollama on `localhost`.
- Prompts routed to ChatGPT are submitted through the normal ChatGPT web interface.
- Ensure no sensitive prompts are unintentionally routed externally.
- Current code injects prompt content via `innerHTML` in pass-through logic; if handling untrusted markup, consider safer text insertion patterns.

---

## Future Improvements

- Add extension options page to tune:
  - routing patterns
  - confidence threshold
  - model selection
- Support additional URL patterns and robust selector fallback logic.
- Add unit/integration tests for routing and stream parsing.
- Add telemetry hooks (opt-in) for route quality and confidence analysis.
- Improve safety by avoiding `innerHTML` for prompt injection.

---

## License

No license file is currently present in this repository.
Add a `LICENSE` file to define usage and distribution terms.
