# PrivateGPT Layer Chrome Extension

A Chrome extension that augments ChatGPT with **local-vs-cloud routing** logic using Ollama.

It intercepts prompts on `https://chatgpt.com/*` and can:
- run prompts fully on a local Ollama model,
- pass prompts to ChatGPT (cloud), or
- decide dynamically in hybrid mode using an LLM-based router.

---

## Table of Contents

- [Overview](#overview)
- [How It Works](#how-it-works)
- [Features](#features)
- [Tech Stack](#tech-stack)
- [Project Structure](#project-structure)
- [Prerequisites](#prerequisites)
- [Installation (Developer Mode)](#installation-developer-mode)
- [Configuration](#configuration)
- [Usage](#usage)
  - [Mode: Local](#mode-local)
  - [Mode: Cloud](#mode-cloud)
  - [Mode: Hybrid](#mode-hybrid)
- [Routing Logic Summary](#routing-logic-summary)
- [Data and Storage](#data-and-storage)
- [Permissions](#permissions)
- [Troubleshooting](#troubleshooting)
- [Known Limitations](#known-limitations)
- [Roadmap Suggestions](#roadmap-suggestions)
- [Contributing](#contributing)
- [License](#license)

---

## Overview

This extension injects logic into ChatGPT pages to route user prompts between:
- **Local model (Ollama)** for privacy and cost savings,
- **Cloud model (ChatGPT)** for high-complexity or real-time queries.

A popup UI provides:
- mode selection (`Local`, `Cloud`, `Hybrid`),
- local model dropdown (from Ollama),
- counters for token savings and query distribution.

---

## How It Works

When the user presses **Enter** in ChatGPT:
1. The content script intercepts the prompt submission.
2. It checks the selected mode from extension storage.
3. Based on mode:
   - **Local**: sends prompt to Ollama and renders streamed response in-page.
   - **Cloud**: forwards prompt to ChatGPT; optionally prepends a local summary when switching into cloud flow.
   - **Hybrid**: asks a local classifier model to route to local or cloud.
4. It updates usage metrics in `chrome.storage.local`.

---

## Features

- Prompt interception on ChatGPT web app.
- Three operation modes:
  - Local
  - Cloud
  - Hybrid (semantic classifier)
- LLM-based routing with factor scoring (complexity, context dependency, recency, precision, density, capability gap, privacy).
- Real-time/news query cloud override.
- Local response streaming UI with route badge.
- Context summarization (local model) before cloud handoff in relevant transitions.
- Persistent metrics:
  - tokens saved
  - local queries count
  - cloud queries count

---

## Tech Stack

- **Chrome Extension Manifest V3**
- **Vanilla JavaScript** (content script + popup script)
- **Ollama HTTP API** (default at `http://localhost:11434`)
- **ChatGPT Web UI integration** via DOM interception/injection

---

## Project Structure

```text
/home/runner/work/llm_extension/llm_extension
├── manifest.json   # Extension manifest and content script registration
├── content.js      # Prompt interception, routing, local streaming, cloud handoff
├── popup.html      # Popup UI
└── popup.js        # Mode state, counters, Ollama model discovery
```

---

## Prerequisites

- Google Chrome (or Chromium-based browser supporting MV3)
- Ollama installed and running locally
- At least one local model pulled in Ollama
- Access to `https://chatgpt.com/*`

### Example Ollama setup

```bash
ollama serve
ollama pull ministral-3:8b
```

> The current scripts reference `ministral-3:8b` as default for routing/summarization/local generation.

---

## Installation (Developer Mode)

1. Clone or download this repository.
2. Open Chrome and go to `chrome://extensions`.
3. Enable **Developer mode**.
4. Click **Load unpacked**.
5. Select:
   - `/home/runner/work/llm_extension/llm_extension`
6. Ensure Ollama is running at `http://localhost:11434`.
7. Open `https://chatgpt.com/` and start prompting.

---

## Configuration

Current configuration is code-based:

- ChatGPT match target: `https://chatgpt.com/*` (`manifest.json`)
- Default mode fallback: `hybrid` (`content.js`)
- Ollama base URL: `http://localhost:11434`
- Default local model: `ministral-3:8b`

To change model defaults, update references in `content.js` (and optionally in popup behavior).

---

## Usage

Use the extension popup to choose a mode.

### Mode: Local

- All prompts are handled by Ollama.
- Prompt is rendered as local user turn.
- Response is streamed into the page with a “Local” badge.
- `tokensSaved` and `localQueries` counters increment.

### Mode: Cloud

- Prompts are sent to ChatGPT.
- If transitioning from local/fresh state, a locally generated context summary may be prepended before forwarding.
- `cloudQueries` counter increments.

### Mode: Hybrid

- A local classifier evaluates the prompt and returns structured JSON.
- Decision is routed to local or cloud.
- Cloud is forced for real-time/news-like queries and selected high-recency cases.
- If classifier fails, fallback is cloud.

---

## Routing Logic Summary

Hybrid routing currently uses a local classification prompt with score-based thresholds:

- Aggregate score from key factors (plus privacy override weight).
- Route thresholds:
  - low score → local
  - high score → cloud
- Explicit override rules:
  - real-time recency → cloud
  - sensitive/private content → local
  - severe missing-context situations → cloud warning path

Additionally, heuristic keyword checks for real-time/news terms can force cloud.

---

## Data and Storage

### `chrome.storage.local`

- `userChoice`: `"local" | "cloud" | "hybrid"`
- `tokensSaved`: number
- `localQueries`: number
- `cloudQueries`: number

### `window.localStorage`

- `chat_history`: recent message snapshots used for local context summarization (trimmed to latest 20 entries).

---

## Permissions

Defined in `manifest.json`:

- `scripting`
- `storage`

Content scripts are injected on:
- `https://chatgpt.com/*`

---

## Troubleshooting

### Popup shows “Ollama not running”
- Start Ollama server: `ollama serve`
- Verify API reachable: `http://localhost:11434/api/tags`

### No local models in dropdown
- Pull a model first, e.g. `ollama pull ministral-3:8b`

### Prompts are not intercepted
- Confirm you are on `https://chatgpt.com/*`
- Reload extension in `chrome://extensions`
- Refresh ChatGPT tab

### Local streaming fails
- Check model availability and exact model name
- Verify Ollama server logs for generation errors

### Unexpected cloud fallback in hybrid mode
- Classifier/network/model failure defaults to cloud for safety
- Real-time/news queries may be intentionally forced to cloud

---

## Known Limitations

- ChatGPT DOM integration is selector-dependent and may break if ChatGPT UI changes.
- Some UI references in popup logic expect elements not currently present in markup (e.g., reset/efficiency-related handlers), which can affect parts of popup behavior.
- No automated test suite or lint/build pipeline is currently included in this repository.
- Host permissions are narrowly targeted to `chatgpt.com` and local Ollama assumptions are hardcoded.

---

## Roadmap Suggestions

- Add configurable Ollama host and default model in popup settings.
- Harden classifier parsing and add structured validation.
- Add robust error banners in popup/content UI.
- Add automated tests for routing logic and parser utilities.
- Add extension icons, branding assets, and versioning discipline.
- Add CI for static checks.

---

## Contributing

1. Fork the repository.
2. Create a feature branch.
3. Make focused changes.
4. Test manually in Chrome with Ollama running.
5. Open a pull request with clear reproduction/verification notes.

---

## License

No license file is currently present in this repository.

If you plan to distribute this project, add an explicit license (for example MIT, Apache-2.0, or GPL).
