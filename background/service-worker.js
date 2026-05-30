/* service-worker.js — the only place that talks to an AI provider.
   Keeps the user's key off the LinkedIn page and sidesteps CORS.
   Messages:
     { type: "summarize", text, tone }  -> { ok, tldr } | { ok:false, error }
     { type: "count" }                  -> increments local.sessionCount  */

const MAX_INPUT_CHARS = 4000;

/* endpoint / auth / model per provider (request shapes differ) */
const PROVIDERS = {
  deepseek: { kind: "openai", url: "https://api.deepseek.com/chat/completions", model: "deepseek-chat" },
  openai:   { kind: "openai", url: "https://api.openai.com/v1/chat/completions", model: "gpt-4o-mini" },
  claude:   { kind: "anthropic", url: "https://api.anthropic.com/v1/messages", model: "claude-3-5-haiku-latest" },
  gemini:   { kind: "gemini", url: "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent", model: "gemini-2.0-flash" },
};

/* canned lines shown when the user has no key yet (demo mode) */
const DEMO = [
  "Add an API key in the popup and this becomes a real, brutal TL;DR.",
  "Demo mode: someone said a lot of words to say almost nothing.",
  "Demo mode: add a key to find out how little this post actually says.",
  "This is a placeholder. Your key turns it into honest one-line shade.",
];

function systemPrompt(tone) {
  const flavor = tone === "brutal"
    ? "brutally honest, dry, and a little snarky — call out humble-brags, engagement bait, and fake-vulnerable hustle takes"
    : "neutral and factual";
  return `Summarize this LinkedIn post in ONE sentence. Be ${flavor}. Max 18 words. No emojis, no hashtags.`;
}

/* tidy any provider's output down to a clean one-liner */
function normalize(s) {
  if (!s) return "";
  let out = String(s).trim();
  out = out.replace(/^["'`]+|["'`]+$/g, "");           // wrapping quotes
  out = out.replace(/^TL;?DR[:\-—\s]+/i, "");            // stray "TL;DR:" prefix
  out = out.replace(/#\w+/g, "");                        // hashtags
  out = out.replace(/\s+/g, " ").trim();
  return out;
}

function cyrb53(str, seed = 0) {
  let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/* ---- build the request for the active provider ---- */
function buildRequest(cfg, key, sys, text) {
  if (cfg.kind === "openai") {
    return {
      url: cfg.url,
      init: {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${key}` },
        body: JSON.stringify({
          model: cfg.model,
          messages: [{ role: "system", content: sys }, { role: "user", content: text }],
          temperature: 0.7,
          max_tokens: 80,
        }),
      },
    };
  }
  if (cfg.kind === "anthropic") {
    return {
      url: cfg.url,
      init: {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": key,
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true",
        },
        body: JSON.stringify({
          model: cfg.model,
          max_tokens: 80,
          system: sys,
          messages: [{ role: "user", content: text }],
        }),
      },
    };
  }
  // gemini — key in query string, system as systemInstruction
  return {
    url: `${cfg.url}?key=${encodeURIComponent(key)}`,
    init: {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: sys }] },
        contents: [{ role: "user", parts: [{ text }] }],
        generationConfig: { temperature: 0.7, maxOutputTokens: 80 },
      }),
    },
  };
}

/* ---- pull the string out of each provider's response ---- */
function parseResponse(kind, data) {
  if (kind === "openai") return data?.choices?.[0]?.message?.content || "";
  if (kind === "anthropic") {
    const block = (data?.content || []).find((b) => b.type === "text") || data?.content?.[0];
    return block?.text || "";
  }
  // gemini
  const parts = data?.candidates?.[0]?.content?.parts || [];
  return parts.map((p) => p.text || "").join(" ");
}

async function summarize(text, tone) {
  const clipped = text.slice(0, MAX_INPUT_CHARS);
  const { provider } = await chrome.storage.sync.get(["provider"]);
  const activeProvider = provider || "deepseek";
  const { keys } = await chrome.storage.local.get(["keys"]);
  const key = keys && keys[activeProvider];

  if (!key) {
    // demo mode — stable line per post so it doesn't flicker on re-scroll
    const idx = cyrb53(clipped) % DEMO.length;
    return { ok: true, tldr: DEMO[idx], demo: true };
  }

  const cfg = PROVIDERS[activeProvider];
  if (!cfg) return { ok: false, error: `Unknown provider: ${activeProvider}` };

  const sys = systemPrompt(tone);
  const { url, init } = buildRequest(cfg, key, sys, clipped);

  try {
    const res = await fetch(url, init);
    if (!res.ok) {
      let detail = "";
      try {
        const err = await res.json();
        detail = err?.error?.message || err?.error?.type || err?.message || "";
      } catch (_) {}
      return { ok: false, error: `${activeProvider} ${res.status}${detail ? ": " + detail : ""}` };
    }
    const data = await res.json();
    const tldr = normalize(parseResponse(cfg.kind, data));
    if (!tldr) return { ok: false, error: "Empty summary from provider" };
    return { ok: true, tldr };
  } catch (e) {
    return { ok: false, error: `Network error: ${e && e.message ? e.message : e}` };
  }
}

/* ---- session counter (serialized to avoid read/modify/write races) ---- */
let counterChain = Promise.resolve();
function incrementCounter() {
  counterChain = counterChain.then(async () => {
    const { sessionCount } = await chrome.storage.local.get(["sessionCount"]);
    await chrome.storage.local.set({ sessionCount: (sessionCount || 0) + 1 });
  });
  return counterChain;
}

async function resetSession() {
  await chrome.storage.local.set({ sessionCount: 0 });
}

/* ---- message router ---- */
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || !msg.type) return;
  if (msg.type === "summarize") {
    summarize(msg.text || "", msg.tone || "brutal").then(sendResponse);
    return true; // async response
  }
  if (msg.type === "count") {
    incrementCounter().then(() => sendResponse({ ok: true })).catch(() => sendResponse({ ok: false }));
    return true;
  }
});

/* reset the "this session" counter when a new browser session starts */
chrome.runtime.onStartup.addListener(resetSession);
chrome.runtime.onInstalled.addListener(resetSession);
