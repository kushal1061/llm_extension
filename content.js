console.log("Extension loaded");

let lastText = "";
let isProcessing = false;

const ROUTING_RULES = {
    local: [
        { category: "math", pattern: /\b(calculate|solve|integral|derivative|equation|algebra|geometry|trigonometry|matrix|factorial|prime|modulo|\d+\s*[\+\-\*\/\^]\s*\d+)\b/i },
        { category: "coding", pattern: /\b(code|function|class|algorithm|bug|debug|refactor|syntax|variable|loop|recursion|api|json|html|css|javascript|python|java|typescript|sql|bash|shell|regex)\b/i },
        { category: "general", pattern: /\b(what is|define|explain|describe|difference between|how does|meaning of|tell me about)\b/i },
        { category: "creative", pattern: /\b(write a|poem|story|essay|letter|joke|haiku|summarize|paraphrase|rewrite|translate)\b/i },
        { category: "reasoning", pattern: /\b(if .* then|pros and cons|compare|analyze|evaluate|rank|list|enumerate|step.by.step)\b/i },
    ],
    chatgpt: [
        { category: "realtime", pattern: /\b(today|right now|current|latest|news|stock price|weather|live|trending|who won|score)\b/i },
        { category: "web", pattern: /\b(search the web|browse|open url|visit|website|link|http|image of|generate image|dall.?e|midjourney)\b/i },
        { category: "longctx", pattern: /\b(entire codebase|full file|all pages|complete document|upload|pdf|attachment)\b/i },
    ],
};

const LOCAL_CATEGORIES = new Set([
    "math", "coding", "general_knowledge", "creative_writing",
    "reasoning", "language", "summarization", "translation",
]);

const CONFIDENCE_THRESHOLD = 0.65;

function keywordRoute(query) {
    const q = query.toLowerCase();

    for (const rule of ROUTING_RULES.chatgpt) {
        if (rule.pattern.test(q)) {
            console.log(`Keyword -> CHATGPT [${rule.category}]`);
            return { decision: "chatgpt", category: rule.category, layer: 1 };
        }
    }

    for (const rule of ROUTING_RULES.local) {
        if (rule.pattern.test(q)) {
            console.log(`Keyword -> LOCAL [${rule.category}]`);
            return { decision: "local", category: rule.category, layer: 1 };
        }
    }

    console.log("Keyword -> UNKNOWN");
    return { decision: "unknown", category: null, layer: 1 };
}

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

Respond ONLY with valid JSON:
{"category": "<one of the above>", "confidence": <0.0 to 1.0>}

User query: "${query.replace(/"/g, '\\"')}"
`.trim();

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
        const clean = raw.replace(/```json|```/g, "").trim();
        const parsed = JSON.parse(clean);
        const { category, confidence } = parsed;
        const decision = LOCAL_CATEGORIES.has(category) ? "local" : "chatgpt";

        console.log(`LLM classifier -> ${decision.toUpperCase()} [${category}] confidence=${confidence}`);
        return { decision, category, confidence, layer: 2 };
    } catch (err) {
        console.error("LLM classifier failed:", err.message);
        return { decision: "chatgpt", category: "unknown", confidence: 0, layer: 2 };
    }
}

async function semanticRoute(query) {
    const l1 = keywordRoute(query);
    if (l1.decision !== "unknown") {
        return { ...l1, confidence: null };
    }

    const l2 = await llmCategoryRoute(query);
    if (l2.confidence < CONFIDENCE_THRESHOLD) {
        console.log(`Low confidence (${l2.confidence}) -> CHATGPT fallback`);
        return { ...l2, decision: "chatgpt" };
    }

    return l2;
}

async function* streamOllamaResponse(response) {
    if (!response.ok) {
        throw new Error(`Ollama HTTP error: ${response.status}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

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
            if (json.response) {
                yield json.response;
            }
            if (json.done) {
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
        ? `Local | ${routeInfo.category}${routeInfo.confidence ? ` | ${Math.round(routeInfo.confidence * 100)}%` : ""} | Layer ${routeInfo.layer}`
        : `ChatGPT | ${routeInfo.category}`;

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
    const cursor = document.createElement("span");
    cursor.innerText = "|";
    cursor.style.cssText = "animation: blink 0.7s step-end infinite;";

    bubble.appendChild(textNode);
    bubble.appendChild(cursor);

    try {
        for await (const token of tokenGenerator) {
            textNode.textContent += token;
        }
    } catch (err) {
        bubble.innerText = `Error: ${err.message}`;
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

function passThroughToChatGPT(editor, query) {
    console.log("Passing to ChatGPT:", query);
    editor.innerHTML = `<p>${query}</p>`;
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
            passThroughToChatGPT(editor, userQuery);
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
