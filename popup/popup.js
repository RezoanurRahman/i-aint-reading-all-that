/* popup.js — settings UI for "I ain't reading all that".
   sync:  enabled, tone, accent (4-color array), cardStyle, provider
   local: keys { deepseek, openai, claude, gemini }, sessionCount  */

/* themeable accent palettes: [accent, accentDeep, tint, tint2] */
const THEMES = {
  "Electric violet": ["#6D4AFF", "#5331E6", "#F1EEFF", "#E0D9FF"],
  "Teal":            ["#12B5A4", "#0C8C7F", "#E6FAF7", "#C7F1EB"],
  "Hot magenta":     ["#E8458C", "#C92E72", "#FEEDF5", "#FBD7E8"],
  "Graphite":        ["#3C3A44", "#26252C", "#F0EFF2", "#E0DEE5"],
};

/* one key active at a time */
const PROVIDERS = {
  deepseek: { name: "DeepSeek",           model: "deepseek-chat",          placeholder: "sk-••••••••••••••••" },
  openai:   { name: "OpenAI (GPT)",       model: "gpt-4o-mini",            placeholder: "sk-proj-••••••••••••" },
  claude:   { name: "Claude (Anthropic)", model: "claude-3-5-haiku-latest", placeholder: "sk-ant-••••••••••••" },
  gemini:   { name: "Gemini (Google)",    model: "gemini-2.0-flash",       placeholder: "AIza••••••••••••••" },
};

const DEFAULTS = {
  enabled: true,
  tone: "brutal",
  accent: THEMES["Electric violet"],
  cardStyle: "filled",
  provider: "deepseek",
};

const $ = (id) => document.getElementById(id);

/* chrome.storage only exists when loaded as an extension; degrade
   gracefully (defaults, no persistence) in a plain page preview */
const STORE = (typeof chrome !== "undefined" && chrome.storage) ? chrome.storage : null;
const syncSet = (obj) => STORE && STORE.sync.set(obj);
const localSet = (obj) => STORE && STORE.local.set(obj);

let state = { ...DEFAULTS, keys: {}, sessionCount: 0 };

/* ---------- helpers ---------- */
function shortProvider(key) {
  return PROVIDERS[key].name.replace(/ \(.*\)/, "");
}

function applyAccent(accent) {
  const [a, d, t1, t2] = accent;
  const r = document.documentElement.style;
  r.setProperty("--accent", a);
  r.setProperty("--accent-deep", d);
  r.setProperty("--tint", t1);
  r.setProperty("--tint2", t2);
}

function setSegOn(container, predicate) {
  container.querySelectorAll("button").forEach((b) => {
    b.classList.toggle("on", predicate(b));
  });
}

/* ---------- rendering ---------- */
function renderEnabled() {
  $("enabledSwitch").classList.toggle("on", state.enabled);
  $("enabledHint").textContent = state.enabled
    ? "On — collapsing the slop."
    : "Off — godspeed, reader.";
}

function renderTone() {
  setSegOn($("toneSeg"), (b) => b.dataset.tone === state.tone);
}

function renderCardStyle() {
  setSegOn($("cardStyleSeg"), (b) => b.dataset.card === state.cardStyle);
}

function renderSwatches() {
  const wrap = $("swatches");
  wrap.innerHTML = "";
  for (const [name, pal] of Object.entries(THEMES)) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "swatch" + (state.accent[0] === pal[0] ? " on" : "");
    btn.title = name;
    btn.style.background = pal[0];
    btn.addEventListener("click", () => {
      state.accent = pal;
      applyAccent(pal);
      renderSwatches();
      syncSet({ accent: pal });
    });
    wrap.appendChild(btn);
  }
}

function renderProviderField() {
  const sel = $("providerSelect");
  if (!sel.options.length) {
    for (const [key, p] of Object.entries(PROVIDERS)) {
      const opt = document.createElement("option");
      opt.value = key;
      opt.textContent = p.name;
      sel.appendChild(opt);
    }
  }
  sel.value = state.provider;
  $("keyInput").value = state.keys[state.provider] || "";
  $("keyInput").placeholder = PROVIDERS[state.provider].placeholder;
  renderKeyStat();
}

function renderKeyStat() {
  const el = $("keyStat");
  const p = PROVIDERS[state.provider];
  const name = shortProvider(state.provider);
  if (state.keys[state.provider]) {
    el.className = "keystat";
    el.textContent = `● Key saved — summaries via ${name} (${p.model}).`;
  } else {
    el.className = "keystat empty";
    el.textContent = `○ No ${name} key yet. Demo summaries shown below.`;
  }
}

function renderCounter() {
  $("counterNum").textContent = state.sessionCount || 0;
}

function renderAll() {
  applyAccent(state.accent);
  renderEnabled();
  renderTone();
  renderCardStyle();
  renderSwatches();
  renderProviderField();
  renderCounter();
}

/* ---------- events ---------- */
function wireEvents() {
  $("enabledSwitch").addEventListener("click", () => {
    state.enabled = !state.enabled;
    renderEnabled();
    syncSet({ enabled: state.enabled });
  });

  $("toneSeg").addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;
    state.tone = btn.dataset.tone;
    renderTone();
    syncSet({ tone: state.tone });
  });

  $("cardStyleSeg").addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;
    state.cardStyle = btn.dataset.card;
    renderCardStyle();
    syncSet({ cardStyle: state.cardStyle });
  });

  $("providerSelect").addEventListener("change", (e) => {
    state.provider = e.target.value;
    renderProviderField();
    syncSet({ provider: state.provider });
  });

  const saveKey = () => {
    const val = $("keyInput").value.trim();
    state.keys = { ...state.keys, [state.provider]: val };
    renderKeyStat();
    localSet({ keys: state.keys });
  };
  $("saveKey").addEventListener("click", saveKey);
  $("keyInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") saveKey();
  });
}

/* keep the popup in sync if storage changes while it's open
   (e.g. the session counter ticking up as you scroll the feed) */
function watchStorage() {
  if (!STORE) return;
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "sync") {
      if (changes.enabled) { state.enabled = changes.enabled.newValue; renderEnabled(); }
      if (changes.tone) { state.tone = changes.tone.newValue; renderTone(); }
      if (changes.accent) { state.accent = changes.accent.newValue; applyAccent(state.accent); renderSwatches(); }
      if (changes.cardStyle) { state.cardStyle = changes.cardStyle.newValue; renderCardStyle(); }
      if (changes.provider) { state.provider = changes.provider.newValue; renderProviderField(); }
    } else if (area === "local") {
      if (changes.sessionCount) { state.sessionCount = changes.sessionCount.newValue || 0; renderCounter(); }
      if (changes.keys) { state.keys = changes.keys.newValue || {}; renderKeyStat(); }
    }
  });
}

/* ---------- init ---------- */
async function init() {
  if (!STORE) {
    renderAll();
    wireEvents();
    return;
  }
  const sync = await chrome.storage.sync.get(["enabled", "tone", "accent", "cardStyle", "provider"]);
  const local = await chrome.storage.local.get(["keys", "sessionCount"]);
  state = {
    enabled: sync.enabled ?? DEFAULTS.enabled,
    tone: sync.tone ?? DEFAULTS.tone,
    accent: sync.accent ?? DEFAULTS.accent,
    cardStyle: sync.cardStyle ?? DEFAULTS.cardStyle,
    provider: sync.provider ?? DEFAULTS.provider,
    keys: local.keys ?? {},
    sessionCount: local.sessionCount ?? 0,
  };
  renderAll();
  wireEvents();
  watchStorage();
}

document.addEventListener("DOMContentLoaded", init);
