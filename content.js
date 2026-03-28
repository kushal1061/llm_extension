console.log("Extension loaded");

let lastText = "";
let isProcessing = false;
function buildClassifierPrompt(userPrompt, conversationHistory = []) {

  const historyText = conversationHistory.length > 0
    ? conversationHistory
        .slice(-6)
        .map(m => `${m.role.toUpperCase()}: ${m.content.slice(0, 200)}`)
        .join('\n')
    : 'None';

  return `You are a prompt router. Your job is to classify whether a user prompt should be handled by a LOCAL LLM or sent to a CLOUD LLM (ChatGPT).

Analyze the prompt carefully across all factors below. Be conservative — only route locally if you are confident the local model can handle it well.

---

## CONVERSATION HISTORY (up to last 3 turns / 6 messages)
${historyText}

---

## USER PROMPT TO CLASSIFY
"""
${userPrompt}
"""

---

## CLASSIFICATION FACTORS

Evaluate each factor and assign a score. Be honest and precise.

### FACTOR 1 — Task complexity [0–3]
0 = Trivial. Single-step lookup, definition, translation, simple math.
1 = Moderate. Short explanation, basic creative writing, summarization of provided text.
2 = High. Multi-step reasoning, code generation, structured analysis, comparisons.
3 = Very high. Architecture design, long-form writing, debugging complex code, deep research synthesis.
Score: ?

### FACTOR 2 — Context dependency [0–3]
0 = Fully self-contained. No reference to prior messages, uploaded files, or external documents.
1 = Light context. References something vague ("that idea", "the plan") but interpretable standalone.
2 = Heavy context. Explicitly references prior conversation, "the code above", "my document", "earlier".
3 = Cannot be answered without history. The prompt is meaningless without prior context.
Score: ?

### FACTOR 3 — Knowledge recency requirement [0–3]
0 = Timeless knowledge. Math, science fundamentals, history, definitions, coding concepts.
1 = Slow-changing. Best practices, established frameworks, general world knowledge.
2 = Recent knowledge required. Events, releases, or changes from the last 1–2 years.
3 = Real-time required. Today's news, live prices, current weather, breaking events.
Score: ?

### FACTOR 4 — Output precision requirement [0–3]
0 = Casual. A poem, a joke, a conversational reply. Minor errors are fine.
1 = General. An explanation or summary. Small inaccuracies tolerable.
2 = Professional. Code that should run, factual writing, structured documents.
3 = Critical. Medical, legal, financial, security-sensitive content. Errors have real consequences.
Score: ?

### FACTOR 5 — Prompt length and information density [0–2]
0 = Short and simple (under 30 words, single question or task).
1 = Medium (30–100 words, some constraints or context provided).
2 = Long or dense (100+ words, multiple requirements, detailed instructions).
Score: ?

### FACTOR 6 — Capability gap risk [0–3]
Does this task specifically require frontier model capabilities?
0 = No. A 7B–13B local model handles this comfortably.
1 = Unlikely to matter. Local model should manage but may be slightly weaker.
2 = Likely matters. Task benefits significantly from a larger, more capable model.
3 = Definite gap. Requires strong reasoning, nuanced judgment, or broad world knowledge that small models lack.
Score: ?

### FACTOR 7 — Privacy sensitivity [0 or -2]
Does the prompt contain sensitive personal, financial, health, or business-confidential information that the user likely does NOT want sent to a cloud API?
0 = Not sensitive. Safe to send to cloud.
-2 = Sensitive. Strong reason to keep this local regardless of other factors.
Score: ?

---

## SCORING RULES

Add up Factors 1–6, then add Factor 7 (which may subtract).

Total score range: -2 to 17

Routing thresholds:
- Score 0–4   → LOCAL
- Score 5–8   → LOCAL (but flag low confidence)
- Score 9–12  → CLOUD
- Score 13–17 → CLOUD (high confidence)

OVERRIDE RULES (apply before threshold):
- If Factor 3 score is 3 → ALWAYS route CLOUD (real-time data impossible locally)
- If Factor 7 score is -2 → ALWAYS route LOCAL (privacy override)
- If Factor 2 score is 3 AND no history was provided → route CLOUD with warning

---

## YOUR RESPONSE

Respond ONLY with valid JSON. No explanation outside the JSON block.

{
  "scores": {
    "complexity": <0–3>,
    "context_dependency": <0–3>,
    "recency": <0–3>,
    "precision": <0–3>,
    "density": <0–2>,
    "capability_gap": <0–3>,
    "privacy": <0 or -2>
  },
  "total": <number>,
  "route": "local" | "cloud",
  "confidence": "high" | "medium" | "low",
  "override": null | "real_time_data" | "privacy" | "missing_context",
  "reason": "<one sentence explaining the key reason for this routing decision>"
}`;
}
function stripMarkdownCodeFence(text) {
    const trimmed = (text || "").trim();
    if (!trimmed.startsWith("```")) {
        return trimmed;
    }

    const firstNewline = trimmed.indexOf("\n");
    if (firstNewline === -1) {
        return trimmed;
    }

    const withoutOpeningFence = trimmed.slice(firstNewline + 1);
    const closingFenceIndex = withoutOpeningFence.lastIndexOf("```");
    if (closingFenceIndex === -1) {
        return withoutOpeningFence.trim();
    }

    return withoutOpeningFence.slice(0, closingFenceIndex).trim();
}

function normalizeClassifierResult(parsed) {
    const route = String(parsed?.route || "").toLowerCase();
    const confidence = String(parsed?.confidence || "").toLowerCase();
    const override = parsed?.override ?? null;
    const total = Number.isFinite(parsed?.total) ? parsed.total : null;
    const decision = route === "local" ? "local" : "chatgpt";

    return {
        decision,
        route,
        confidence,
        override,
        total,
        reason: parsed?.reason || "",
        scores: parsed?.scores || null,
        layer: 2,
    };
}

function isRealtimeOrNewsQuery(query) {
    const normalizedQuery = String(query || "").toLowerCase();
    const recencyTerms = ["latest", "current", "today", "recent", "breaking", "live", "right now"];
    const newsTerms = ["news", "headline", "headlines", "update", "updates"];
    const realtimeTopics = ["weather", "stock", "stocks", "price", "prices", "score", "scores"];

    const hasRecencyTerm = recencyTerms.some(term => normalizedQuery.includes(term));
    const hasNewsTerm = newsTerms.some(term => normalizedQuery.includes(term));
    const hasRealtimeTopic = realtimeTopics.some(term => normalizedQuery.includes(term));

    return (hasRecencyTerm && hasNewsTerm) || hasRealtimeTopic;
}

async function llmCategoryRoute(query) {
    const classifierPrompt = buildClassifierPrompt(query); 
    try {
        const response = await fetch("http://localhost:11434/api/generate", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                model: "ministral-3:8b",
                prompt: classifierPrompt,
                stream: false,
            }),
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }

        const data = await response.json();
        const raw = (data.response || "").trim();
        const clean = stripMarkdownCodeFence(raw);
        const parsed = JSON.parse(clean);
        const result = normalizeClassifierResult(parsed);

        console.log(
            `LLM classifier -> ${result.decision.toUpperCase()} [route=${result.route}] confidence=${result.confidence} total=${result.total}`
        );
        return result;
    } catch (err) {
        console.error("LLM classifier failed:", err.message);
        return {
            decision: "chatgpt",
            route: "cloud",
            confidence: "low",
            override: null,
            total: null,
            reason: "Classifier failed, defaulting to cloud.",
            scores: null,
            layer: 2,
        };
    }
}

async function semanticRoute(query) {
    const llmRoute = await llmCategoryRoute(query);

    if (
        llmRoute.override === "real_time_data" ||
        llmRoute.scores?.recency === 3 ||
        isRealtimeOrNewsQuery(query)
    ) {
        console.log("Real-time/news query detected -> CHATGPT");
        return { ...llmRoute, decision: "chatgpt", override: llmRoute.override || "real_time_data" };
    }

    if (llmRoute.confidence === "low" && llmRoute.decision === "local") {
        console.log(`Low confidence (${llmRoute.confidence}) -> CHATGPT fallback`);
        return { ...llmRoute, decision: "chatgpt" };
    }

    return llmRoute;
}

async function* streamOllamaResponse(response) {
    if (!response.ok) {
        throw new Error(`Ollama HTTP error: ${response.status}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let result="";
    while (true) {
        const { done, value } = await reader.read();
        if (done) {
            break;
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) {
                continue;
            }

            const json = JSON.parse(trimmed);
            result += json.response || "";
            if (json.response) {
                yield json.response;
            }
            if (json.done) {
                addMessage("ollama", result);
                console.log("Ollama stream ended");
                return;
            }
            if (json.error) {
                throw new Error(`Ollama: ${json.error}`);
            }
        }
    }


    if (!buffer.trim()) {
        return;
    }

    const json = JSON.parse(buffer.trim());
    if (json.response) {
        yield json.response;
    }
}
function addMessage(role, content) {
  let history = JSON.parse(localStorage.getItem("chat_history")) || [];

  history.push({
    role, // "user" or "assistant"
    content,
    time: Date.now()
  });

  // keep last 20 messages max
  if (history.length > 20) {
    history = history.slice(-20);
  }

  localStorage.setItem("chat_history", JSON.stringify(history));
}
function getConversationContainer() {
    const turns = document.querySelectorAll('article[data-testid^="conversation-turn-"], section[data-turn]');
    if (turns.length > 0) {
        return turns[turns.length - 1].parentElement || document.body;
    }

    const existingHost = document.getElementById("local-thread-host");
    if (existingHost) {
        return existingHost;
    }

    const composer = document.querySelector("#prompt-textarea");
    const composerForm = composer ? composer.closest("form") : null;
    const main = document.querySelector("main") || document.body;
    const host = document.createElement("div");
    host.id = "local-thread-host";
    host.style.cssText = `
        width: 100%;
        max-width: 48rem;
        margin: 0 auto 16px;
        padding: 0 16px;
        box-sizing: border-box;
    `;

    if (composerForm && composerForm.parentElement) {
        composerForm.parentElement.insertAdjacentElement("beforebegin", host);
    } else {
        main.appendChild(host);
    }

    return host;
}

function renderLocalUserPrompt(query) {
    const container = getConversationContainer();
    const section = document.createElement("section");
    section.setAttribute("data-turn", "user");
    section.style.cssText = "margin-top: 12px; display: flex; justify-content: flex-end;";

    const bubble = document.createElement("div");
    bubble.className = "user-message-bubble-color corner-superellipse/0.98 relative rounded-[22px] px-4 py-2.5 leading-6 max-w-(--user-chat-width,70%)";
    bubble.style.cssText = `
        white-space: pre-wrap;
        word-break: break-word;
    `;
    bubble.innerText = query;

    section.appendChild(bubble);
    container.appendChild(section);
    section.scrollIntoView({ block: "end", behavior: "smooth" });
}

function createResponseBubble(routeInfo) {
    const container = getConversationContainer();
    const isLocal = routeInfo.decision === "local";
    const section = document.createElement("section");
    section.setAttribute("data-turn", "assistant");
    section.style.marginTop = "12px";

    const badge = document.createElement("div");
    badge.style.cssText = `
        display: inline-block;
        font-size: 11px;
        font-family: monospace;
        padding: 2px 8px;
        border-radius: 4px;
        margin-bottom: 6px;
        background: ${isLocal ? "#10a37f22" : "#e5530022"};
        color: ${isLocal ? "#10a37f" : "#e55300"};
        border: 1px solid ${isLocal ? "#10a37f55" : "#e5530055"};
    `;
    badge.innerText = isLocal
        ? `Local | ${routeInfo.confidence || "unknown"} confidence | Layer ${routeInfo.layer}`
        : `ChatGPT | ${routeInfo.override || routeInfo.confidence || "cloud"}`;

    const bubble = document.createElement("div");
    bubble.style.cssText = `
        padding: 12px 16px;
        background: #2d2d2d;
        color: #f0f0f0;
        border-radius: 10px;
        border-left: 3px solid ${isLocal ? "#10a37f" : "#e55300"};
        font-family: ui-monospace, monospace;
        font-size: 14px;
        line-height: 1.6;
        white-space: pre-wrap;
        word-break: break-word;
        box-shadow: 0 2px 8px rgba(0,0,0,0.3);
    `;

    const wrapper = document.createElement("div");
    wrapper.appendChild(badge);
    wrapper.appendChild(bubble);
    section.appendChild(wrapper);
    container.appendChild(section);
    section.scrollIntoView({ block: "end", behavior: "smooth" });

    return bubble;
}

function ensureCursorStyle() {
    if (document.getElementById("llm-cursor-style")) {
        return;
    }

    const style = document.createElement("style");
    style.id = "llm-cursor-style";
    style.textContent = "@keyframes blink { 0%,100%{opacity:1} 50%{opacity:0} }";
    document.head.appendChild(style);
}

async function injectStreamingResponse(tokenGenerator, routeInfo) {
    const bubble = createResponseBubble(routeInfo);
    ensureCursorStyle();

    const textNode = document.createTextNode("");
    // Thinking placeholder
    const thinking = document.createElement("span");
    thinking.innerText = "Thinking";
    thinking.style.opacity = "0.7";

    // Animated dots
    const dots = document.createElement("span");
    dots.innerText = "...";
    dots.style.cssText = "animation: blink 1s infinite;";
    //---
    const cursor = document.createElement("span");
    cursor.innerText = "|";
    cursor.style.cssText = "animation: blink 0.7s step-end infinite;";

    bubble.appendChild(thinking);
    bubble.appendChild(dots);
    bubble.appendChild(cursor);
    let started = false;
   try {
        for await (const token of tokenGenerator) {

            // 🔥 First token → remove thinking UI
            if (!started) {
                started = true;
                bubble.innerHTML = "";
                bubble.appendChild(textNode);
                bubble.appendChild(cursor);
            }

            textNode.textContent += token;
        }

    } catch (err) {
        bubble.innerText = `❌ Error: ${err.message}`;
        console.error("Streaming error:", err);
        return;
    }

    cursor.remove();
    console.log("Streaming complete");
}

async function getLocalStreamingResponse(query, model = "ministral-3:8b") {
    return fetch("http://localhost:11434/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            model: model || "ministral-3:8b",
            prompt: query,
            stream: true,
        }),
    });
}

async function findModels() {
    const response = await fetch("http://localhost:11434/api/tags");
    if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json();
    console.log("Available models:", data.models);
    return data.models;
}

function passThroughToChatGPT(editor, query, summary = "") {
    console.log("Passing to ChatGPT:", query);
    editor.innerHTML = `<p>summary:${summary},original_query:${query}</p>`;
    editor.dispatchEvent(new InputEvent("input", { bubbles: true }));

    setTimeout(() => {
        editor.dispatchEvent(new KeyboardEvent("keydown", {
            key: "Enter",
            code: "Enter",
            keyCode: 13,
            bubbles: true,
            cancelable: true,
        }));
    }, 50);
}

///
function getRecentContext() {
  let history = JSON.parse(localStorage.getItem("chat_history")) || [];

  let users = [];
  let assistants = [];

  // traverse from latest → oldest
  for (let i = history.length - 1; i >= 0; i--) {
    let msg = history[i];

    if (msg.role === "user" && users.length < 3) {
      users.push(msg.content);
    }

    if (msg.role === "ollama" && assistants.length < 3) {
      assistants.push(msg.content);
    }

    if (users.length === 3 && assistants.length === 3) break;
  }

  return {
    users: users.reverse(),
    assistants: assistants.reverse()
  };
}


/// build context prompt
function buildContextPrompt(users, assistants) {
  return `
You are a context extraction engine for an AI system.

Your task:
Compress the conversation into a sharp, high-signal context summary.

Output requirements:
- Maximum 3 sentences
- Focus ONLY on:
  1. What the user is trying to achieve
  2. Any relevant technical/domain context
- Ignore:
  - greetings, filler, repetition
  - assistant explanations unless they affect user intent
- Do NOT explain, just output the summary
- Be specific, not generic

Conversation:

User Messages:
${users.map((u, i) => `${i + 1}. ${u}`).join("\n")}

Assistant Messages:
${assistants.map((a, i) => `${i + 1}. ${a}`).join("\n")}

Final Context Summary:
`;
}
// generate summary and pass to ChatGPT
async function generateSummary() {
  const { users, assistants } = getRecentContext();
  const prompt = buildContextPrompt(users, assistants);

  const res = await fetch("http://localhost:11434/api/generate", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "ministral-3:8b",
      prompt: prompt,
      stream: false
    })
  });

  const data = await res.json() || "";
  console.log("Summary:", data.response);
  return data.response || "";
}

document.addEventListener("input", () => {
    const inputBox = document.querySelector("#prompt-textarea");
    if (inputBox) {
        lastText = inputBox.innerText.trim();
    }
});
function sendToPopup(type, value) {
    if (type === "TOKEN_UPDATE") {
        chrome.storage.local.get(["tokensSaved"], (res) => {
            chrome.storage.local.set({ tokensSaved: (res.tokensSaved || 0) + value });
        });
    } else if (type === "LOCAL_QUERY_UPDATE") {
        chrome.storage.local.get(["localQueries"], (res) => {
            chrome.storage.local.set({ localQueries: (res.localQueries || 0) + value });
        });
    } else if (type === "CLOUD_QUERY_UPDATE") {
        chrome.storage.local.get(["cloudQueries"], (res) => {
            chrome.storage.local.set({ cloudQueries: (res.cloudQueries || 0) + value });
        });
    }
}
document.addEventListener("keydown", async (e) => {
    if (e.key !== "Enter" || e.shiftKey) {
        return;
    }

    if (isProcessing) {
        return;
    }

    const editor = document.querySelector("#prompt-textarea");
    if (!editor) {
        return;
    }

    const userQuery = editor.innerText.trim();
    editor.innerText = "";
    if (!userQuery) {
        return;
    }

    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();

    isProcessing = true;
    console.log("Intercepted:", userQuery);
    let summary = await generateSummary();

    try {
        const routeInfo = await semanticRoute(userQuery);
        console.log("Final route:", routeInfo);

        if (routeInfo.decision === "local") {
            const userToken = Math.ceil(userQuery.length / 4);
            sendToPopup("TOKEN_UPDATE", userToken);
            sendToPopup("LOCAL_QUERY_UPDATE", 1);
            renderLocalUserPrompt(userQuery);
            const streamResponse = await getLocalStreamingResponse(
                userQuery,
                "ministral-3:8b"
            );

            await findModels();
            await injectStreamingResponse(streamOllamaResponse(streamResponse), routeInfo);
        } else {
            sendToPopup("CLOUD_QUERY_UPDATE", 1);
            passThroughToChatGPT(editor, userQuery,summary);
        }
    } catch (err) {
        console.error("Fatal error:", err);
        sendToPopup("CLOUD_QUERY_UPDATE", 1);
        passThroughToChatGPT(editor, userQuery);
    } finally {
        setTimeout(() => {
            isProcessing = false;
        }, 300);
    }
}, true);
