console.log("✅ Extension loaded");

// ─────────────────────────────────────────────
//  STATE
// ─────────────────────────────────────────────
let lastText = "";
let isProcessing = false;

// ─────────────────────────────────────────────
//  LAYER 1 — KEYWORD + INTENT DETECTION (~0ms)
//  Fast pre-filter before any LLM call.
//  Returns: "local" | "chatgpt" | "unknown"
// ─────────────────────────────────────────────

const ROUTING_RULES = {
    // ── Force LOCAL ───────────────────────────────────────────────────────────
    local: [
        { category: "math",      pattern: /\b(calculate|solve|integral|derivative|equation|algebra|geometry|trigonometry|matrix|factorial|prime|modulo|\d+\s*[\+\-\*\/\^]\s*\d+)\b/i },
        { category: "coding",    pattern: /\b(code|function|class|algorithm|bug|debug|refactor|syntax|variable|loop|recursion|api|json|html|css|javascript|python|java|typescript|sql|bash|shell|regex)\b/i },
        { category: "general",   pattern: /\b(what is|define|explain|describe|difference between|how does|meaning of|tell me about)\b/i },
        { category: "creative",  pattern: /\b(write a|poem|story|essay|letter|joke|haiku|summarize|paraphrase|rewrite|translate)\b/i },
        { category: "reasoning", pattern: /\b(if .* then|pros and cons|compare|analyze|evaluate|rank|list|enumerate|step.by.step)\b/i },
    ],

    // ── Force CHATGPT ─────────────────────────────────────────────────────────
    chatgpt: [
        { category: "realtime",  pattern: /\b(today|right now|current|latest|news|stock price|weather|live|trending|who won|score)\b/i },
        { category: "web",       pattern: /\b(search the web|browse|open url|visit|website|link|http|image of|generate image|dall.?e|midjourney)\b/i },
        { category: "longctx",   pattern: /\b(entire codebase|full file|all pages|complete document|upload|pdf|attachment)\b/i },
    ],
};

/**
 * Layer 1: Pure keyword scan. No network call.
 * @param {string} query
 * @returns {{ decision: "local"|"chatgpt"|"unknown", category: string|null, layer: 1 }}
 */
function keywordRoute(query) {
    const q = query.toLowerCase();

    for (const rule of ROUTING_RULES.chatgpt) {
        if (rule.pattern.test(q)) {
            console.log(`🔑 Keyword → CHATGPT [${rule.category}]`);
            return { decision: "chatgpt", category: rule.category, layer: 1 };
        }
    }

    for (const rule of ROUTING_RULES.local) {
        if (rule.pattern.test(q)) {
            console.log(`🔑 Keyword → LOCAL [${rule.category}]`);
            return { decision: "local", category: rule.category, layer: 1 };
        }
    }

    console.log("🔑 Keyword → UNKNOWN (escalate to LLM classifier)");
    return { decision: "unknown", category: null, layer: 1 };
}

// ─────────────────────────────────────────────
//  LAYER 2 — LLM CATEGORY CLASSIFIER (via Ollama)
//  Only called when Layer 1 returns "unknown".
//  Returns: { decision, category, confidence, layer }
// ─────────────────────────────────────────────

const LOCAL_CATEGORIES = new Set([
    "math", "coding", "general_knowledge", "creative_writing",
    "reasoning", "language", "summarization", "translation",
]);

const CHATGPT_CATEGORIES = new Set([
    "realtime_info", "web_search", "image_generation",
    "file_analysis", "long_context", "specialized_tool",
]);

/**
 * Layer 2: Ask Ollama to classify the query into a category + confidence.
 * @param {string} query
 * @returns {{ decision: "local"|"chatgpt", category: string, confidence: number, layer: 2 }}
 */
async function llmCategoryRoute(query) {
    const classifierPrompt = `
You are a query router. Classify the user query into exactly ONE category and give a confidence score.

CATEGORIES:
Local model can handle:
- math               (arithmetic, algebra, calculus, statistics)
- coding             (code generation, debugging, explanation, algorithms)
- general_knowledge  (facts, definitions, history, science concepts)
- creative_writing   (stories, poems, jokes, essays, rewrites)
- reasoning          (logic puzzles, comparisons, pros/cons, step-by-step)
- language           (grammar, synonyms, translations, style)
- summarization      (condensing text already provided in the query)
- translation        (translate provided text)

Needs ChatGPT / internet:
- realtime_info      (news, weather, stock prices, live scores, today's date)
- web_search         (requires browsing the internet)
- image_generation   (create/edit images)
- file_analysis      (user uploaded a file or references external document)
- long_context       (full codebase, entire book, very large input)
- specialized_tool   (plugins, custom GPTs, code interpreter)

Respond ONLY with valid JSON — no explanation, no markdown:
{"category": "<one of the above>", "confidence": <0.0 to 1.0>}

User query: "${query.replace(/"/g, '\\"')}"
`.trim();

    try {
        const response = await fetch("http://localhost:11434/api/generate", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                model: "qwen3:8b",
                prompt: classifierPrompt,
                stream: false,
            }),
        });

        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const data = await response.json();
        const raw = (data.response || "").trim();
        const clean = raw.replace(/```json|```/g, "").trim();
        const parsed = JSON.parse(clean);

        const { category, confidence } = parsed;
        const decision = LOCAL_CATEGORIES.has(category) ? "local" : "chatgpt";

        console.log(`🧠 LLM Classifier → ${decision.toUpperCase()} [${category}] confidence=${confidence}`);
        return { decision, category, confidence, layer: 2 };

    } catch (err) {
        console.error("❌ LLM classifier failed:", err.message);
        return { decision: "chatgpt", category: "unknown", confidence: 0, layer: 2 };
    }
}

// ─────────────────────────────────────────────
//  SEMANTIC ROUTER — combines both layers
// ─────────────────────────────────────────────

const CONFIDENCE_THRESHOLD = 0.65;

/**
 * Full two-layer semantic router.
 * @param {string} query
 * @returns {{ decision: "local"|"chatgpt", category: string, confidence: number|null, layer: number }}
 */
async function semanticRoute(query) {
    // Layer 1 — free, instant
    const l1 = keywordRoute(query);
    if (l1.decision !== "unknown") return { ...l1, confidence: null };

    // Layer 2 — LLM classifier (only for ambiguous queries)
    const l2 = await llmCategoryRoute(query);

    if (l2.confidence < CONFIDENCE_THRESHOLD) {
        console.log(`⚠️ Low confidence (${l2.confidence}) → falling back to CHATGPT`);
        return { ...l2, decision: "chatgpt" };
    }

    return l2;
}

// ─────────────────────────────────────────────
//  STREAM READER — async generator
// ─────────────────────────────────────────────
async function* streamOllamaResponse(response) {
    if (!response.ok) throw new Error(`Ollama HTTP error: ${response.status}`);

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop();

        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
                const json = JSON.parse(trimmed);
                if (json.response) yield json.response;
                
                if (json.done) {
                    addMessage("ollama", json.response || "");
                    return;
                }
                if (json.error) throw new Error(`Ollama: ${json.error}`);
            } catch (e) {
                console.warn("⚠️ Skipping unparseable line:", trimmed);
            }
        }
    }

    if (buffer.trim()) {
        try {
            const json = JSON.parse(buffer.trim());
            if (json.response) yield json.response;
        } catch (_) {}
    }
}

// ─────────────────────────────────────────────
//  DOM HELPERS
// ─────────────────────────────────────────────
function createResponseBubble(routeInfo) {
    const sections = document.querySelectorAll('section[data-turn="assistant"]');
    const container = sections.length > 0 ? sections[sections.length - 1] : document.body;

    const isLocal = routeInfo.decision === "local";

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
        ? `⚡ Local · ${routeInfo.category}${routeInfo.confidence ? ` · ${Math.round(routeInfo.confidence * 100)}%` : ""} · Layer ${routeInfo.layer}`
        : `☁️ ChatGPT · ${routeInfo.category}`;

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
    wrapper.style.marginTop = "12px";
    wrapper.appendChild(badge);
    wrapper.appendChild(bubble);
    container.appendChild(wrapper);

    return bubble;
}

function ensureCursorStyle() {
    if (document.getElementById("llm-cursor-style")) return;
    const style = document.createElement("style");
    style.id = "llm-cursor-style";
    style.textContent = `@keyframes blink { 0%,100%{opacity:1} 50%{opacity:0} }`;
    document.head.appendChild(style);
}

// ─────────────────────────────────────────────
//  STREAMING INJECTOR
// ─────────────────────────────────────────────
async function injectStreamingResponse(tokenGenerator, routeInfo) {
    const bubble = createResponseBubble(routeInfo);
    ensureCursorStyle();

    const textNode = document.createTextNode("");
    const cursor = document.createElement("span");
    cursor.innerText = "▍";
    cursor.style.cssText = "animation: blink 0.7s step-end infinite;";

    bubble.appendChild(textNode);
    bubble.appendChild(cursor);

    try {
        for await (const token of tokenGenerator) {
            textNode.textContent += token;
        }
    } catch (err) {
        bubble.innerText = `❌ Error: ${err.message}`;
        console.error("Streaming error:", err);
        return;
    }

    cursor.remove();
    console.log("✅ Streaming complete");
}

// ─────────────────────────────────────────────
//  LOCAL LLM RESPONSE
// ─────────────────────────────────────────────
async function getLocalStreamingResponse(query) {
    return fetch("http://localhost:11434/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            model: "qwen3:8b",
            prompt: query,
            stream: true,
        }),
    });
}

// ─────────────────────────────────────────────
//  PASS-THROUGH TO CHATGPT
// ─────────────────────────────────────────────
function passThroughToChatGPT(editor, query) {
    console.log("➡️ Passing to ChatGPT:", query);
    editor.innerHTML = `<p>${query}</p>`;
    editor.dispatchEvent(new InputEvent("input", { bubbles: true }));
    setTimeout(() => {
        editor.dispatchEvent(new KeyboardEvent("keydown", {
            key: "Enter", code: "Enter", keyCode: 13,
            bubbles: true, cancelable: true,
        }));
    }, 50);
}

// ─────────────────────────────────────────────
//  TRACK USER INPUT
// ─────────────────────────────────────────────
document.addEventListener("input", () => {
    const inputBox = document.querySelector("#prompt-textarea");
    if (inputBox) lastText = inputBox.innerText.trim();
});

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

function buildContextPrompt(users, assistants) {
  return `
You are summarizing a conversation.

Goal:
Extract the user's intent and ongoing context.

Rules:
- Keep it under 2 sentences
- Focus on what the user wants
- Ignore small talk

User messages:
${users.map((u, i) => `${i + 1}. ${u}`).join("\n")}

Assistant responses:
${assistants.map((a, i) => `${i + 1}. ${a}`).join("\n")}

Summary:
`;
}

async function generateSummary() {
  const { users, assistants } = getRecentContext();
  const prompt = buildContextPrompt(users, assistants);

  const res = await fetch("http://localhost:11434/api/generate", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "qwen3:8b",
      prompt: prompt,
      stream: false
    })
  });

  const data = await res.json();
  console.log("Summary:", data.response);
  return data.response;
}
// ─────────────────────────────────────────────
//  MAIN KEYDOWN LISTENER
// ─────────────────────────────────────────────
document.addEventListener("keydown", async (e) => {
    if (isProcessing || e.key !== "Enter" || e.shiftKey) return;

    const editor = document.querySelector("#prompt-textarea");
    if (!editor) return;

    const userQuery = editor.innerText.trim();
    if (!userQuery) return;

    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();

    isProcessing = true;
    console.log("🧠 Intercepted:", userQuery);

    try {
        const routeInfo = await semanticRoute(userQuery);
        console.log("📍 Final route:", routeInfo);

        if (routeInfo.decision === "local") {
            addMessage("user", userQuery);
            const streamResponse = await getLocalStreamingResponse(userQuery);
            await injectStreamingResponse(streamOllamaResponse(streamResponse), routeInfo);
        } else {
            passThroughToChatGPT(editor, userQuery);
        }

    } catch (err) {
        console.error("❌ Fatal error:", err);
        passThroughToChatGPT(editor, userQuery);
    } finally {
        setTimeout(() => { isProcessing = false; }, 300);
    }

}, true);