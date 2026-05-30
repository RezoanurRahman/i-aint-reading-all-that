/* content.js — scrapes LinkedIn feed posts, injects the TL;DR card,
   handles expand/collapse, caching, theming and the master on/off.
   The AI itself is called from the service worker, never here. */

(() => {
  "use strict";

  /* ---- brittle DOM selectors — keep them all in one place ---- */
  const SEL = {
    // LinkedIn's rebuilt feed ships hashed CSS classes (e.g. "_01ed4f4a"),
    // so we anchor on stable data-testid hooks. We operate on the post's
    // text box directly — no fragile post-wrapper selector needed.
    // Old class names are kept as fallbacks for the legacy feed.
    textBox: '[data-testid="expandable-text-box"], .feed-shared-update-v2__description, .update-components-text',
    seeMore: '[data-testid="expandable-text-button"], button.feed-shared-inline-show-more-text__see-more-less-toggle',
    // container to observe for infinite scroll; falls back to main/body
    feed: '[data-testid="mainFeed"], .scaffold-finite-scroll__content, main',
  };

  const MIN_TEXT_LEN = 15;
  const CACHE_KEY = "summaryCache";
  const CACHE_CAP = 1000;
  const DEFAULT_ACCENT = ["#6D4AFF", "#5331E6", "#F1EEFF", "#E0D9FF"];
  const BRAND = "TL;DR — I ain't reading all that";

  const settings = {
    enabled: true,
    tone: "brutal",
    accent: DEFAULT_ACCENT.slice(),
    cardStyle: "filled",
  };

  let memCache = {};
  let cacheDirty = false;
  const countedThisSession = new Set();

  /* ============================================================
     utils
     ============================================================ */
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
  const hashText = (t) => "h" + cyrb53(t).toString(36);

  function readTime(text) {
    const words = text.split(/\s+/).filter(Boolean).length;
    const secs = Math.round((words / 200) * 60) + 8; // + the time to realize it's slop
    const m = Math.floor(secs / 60), s = secs % 60;
    return m ? `${m}m ${s}s` : `${s}s`;
  }

  /* cheap client-side heuristics for the chips (no tokens spent).
     README option (c): pattern-match the post text. */
  function aiScore(text) {
    const t = text.toLowerCase();
    const emojis = (text.match(/\p{Extended_Pictographic}/gu) || []).length;
    const lines = text.split(/\n|(?<=[.!?])\s+/).filter(Boolean);
    const shortLineRatio = lines.length ? lines.filter((l) => l.trim().split(/\s+/).length <= 6).length / lines.length : 0;
    let score = 55;
    if (emojis >= 3) score += 12; else if (emojis >= 1) score += 5;
    if (shortLineRatio > 0.5 && lines.length >= 5) score += 14; // broetry cadence
    if (/\b(agree\?|thoughts\?|comment below|drop.{0,12}below|👇)/.test(t)) score += 10;
    if (/\b(unpopular opinion|let that sink in|game ?changer|needle|synergy|thought leader|humbled|grateful|excited to announce)\b/.test(t)) score += 8;
    if (/(\d[\.\)]\s|\d️⃣)/.test(text)) score += 6; // numbered list
    if (/\b(dm me|comment ['"]?\w+|repost|tag (a|someone|three)|save this)\b/.test(t)) score += 8;
    return Math.max(40, Math.min(99, Math.round(score))) + "% AI";
  }

  function flagFor(text) {
    const t = text.toLowerCase();
    const rules = [
      [/cried in my car|i cried|tears/, "crying-CEO"],
      [/work-life balance|never taken a day off|sleep is for|out-?work|burnout|grind|hustle/, "toxic hustle"],
      [/comment ['"]?\w+|like this post|repost|tag (a|someone|three)|save this post|drop.{0,15}below|dm me|👇/, "engagement bait"],
      [/noodles|broke|rock bottom|rejected|parking lot|食|instant noodle/, "fake-vulnerable"],
      [/toddler|my \d+-year-old|my (kid|son|daughter)|nursery|blocks/, "toddler→biz pipeline"],
      [/fired|let (him|her|them) go|laid off|layoff|hardest.{0,20}decision/, "humble-brag"],
    ];
    for (const [re, label] of rules) if (re.test(t)) return "🚩 " + label;
    return "🚩 thought-leader";
  }

  /* ============================================================
     cache persistence (debounced; read once, write in batches)
     ============================================================ */
  let flushTimer = null;
  function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = setTimeout(flushCache, 800);
  }
  async function flushCache() {
    flushTimer = null;
    if (!cacheDirty) return;
    cacheDirty = false;
    const keys = Object.keys(memCache);
    if (keys.length > CACHE_CAP) {
      const drop = keys.slice(0, keys.length - Math.floor(CACHE_CAP * 0.8));
      for (const k of drop) delete memCache[k];
    }
    try { await chrome.storage.local.set({ [CACHE_KEY]: memCache }); } catch (_) {}
  }

  /* ============================================================
     text extraction
     ============================================================ */
  function extractText(container) {
    let t = (container.innerText || container.textContent || "").replace(/\s+/g, " ").trim();
    t = t.replace(/\s*(…\s*more|see more|…more|more)$/i, "").trim();
    return t;
  }

  /* ============================================================
     summary card
     ============================================================ */
  /* true while our extension context is alive; false once orphaned by a
     reload/update, which is when chrome.* calls start to fail */
  function ctxValid() {
    return !!(chrome.runtime && chrome.runtime.id);
  }

  function applyTheme(root) {
    const [a, d, t1, t2] = settings.accent;
    root.style.setProperty("--accent", a);
    root.style.setProperty("--accent-deep", d);
    root.style.setProperty("--tint", t1);
    root.style.setProperty("--tint2", t2);
    root.setAttribute("data-cardstyle", settings.cardStyle);
  }

  function buildCard(meta) {
    const root = document.createElement("div");
    root.className = "iarat-summary";

    const textEl = document.createElement("div");
    textEl.className = "iarat-summary__text iarat-pending";
    textEl.textContent = "Summarizing…";

    // foot: toggle + flag + saved
    const foot = document.createElement("div");
    foot.className = "iarat-summary__foot";

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "iarat-collapse-btn";
    const btnLabel = document.createElement("span");
    btnLabel.className = "iarat-collapse-label";
    btnLabel.textContent = "read all that (if you must)";
    const arr = document.createElement("span");
    arr.className = "iarat-arr";
    arr.textContent = "▾";
    btn.append(btnLabel, arr);

    const flag = document.createElement("span");
    flag.className = "iarat-chip iarat-chip--flag";
    flag.textContent = meta.flag;

    const saved = document.createElement("span");
    saved.className = "iarat-saved";
    saved.innerHTML = "saved you <b></b>";
    saved.querySelector("b").textContent = meta.savedTime;

    foot.append(btn, flag, saved);

    // branding row (visually the bottom of the card)
    const top = document.createElement("div");
    top.className = "iarat-summary__top";
    const logo = document.createElement("div");
    logo.className = "iarat-summary__logo";
    logo.textContent = "I";
    const brand = document.createElement("span");
    brand.className = "iarat-summary__brand";
    brand.textContent = BRAND;
    const flags = document.createElement("div");
    flags.className = "iarat-summary__flags";
    const ai = document.createElement("span");
    ai.className = "iarat-chip iarat-chip--ai";
    ai.textContent = "🤖 " + meta.aiScore;
    flags.append(ai);
    top.append(logo, brand, flags);

    root.append(textEl, foot, top);
    applyTheme(root);

    return { root, textEl, btn, btnLabel, saved };
  }

  function wireToggle(parts, box, extra) {
    parts.btn.addEventListener("click", () => {
      const expanded = box.classList.toggle("iarat-collapsed") === false;
      if (extra) extra.classList.toggle("iarat-collapsed", !expanded);
      parts.btn.classList.toggle("iarat-open", expanded);
      parts.btnLabel.textContent = expanded ? "ok that's enough" : "read all that (if you must)";
      parts.saved.classList.toggle("iarat-hidden", expanded); // saved time only while collapsed
    });
  }

  function setTldr(parts, tldr) {
    parts.textEl.classList.remove("iarat-pending");
    parts.textEl.textContent = tldr;
  }
  function setError(parts) {
    parts.textEl.classList.remove("iarat-pending");
    parts.textEl.textContent = "Couldn't summarize this one. Check your API key in the popup.";
  }

  /* ============================================================
     service-worker comms + small concurrency gate
     ============================================================ */
  function requestSummary(text) {
    return new Promise((resolve) => {
      if (!ctxValid()) { resolve({ ok: false, error: "context invalidated" }); return; }
      try {
        chrome.runtime.sendMessage({ type: "summarize", text, tone: settings.tone }, (resp) => {
          if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
          else resolve(resp || { ok: false, error: "no response" });
        });
      } catch (e) {
        resolve({ ok: false, error: String(e) });
      }
    });
  }
  function bumpCounter() {
    if (!ctxValid()) return;
    try { chrome.runtime.sendMessage({ type: "count" }); } catch (_) {}
  }

  const MAX_CONCURRENT = 3;
  let active = 0;
  const queue = [];
  function enqueue(fn) {
    return new Promise((resolve) => {
      queue.push({ fn, resolve });
      pump();
    });
  }
  function pump() {
    while (active < MAX_CONCURRENT && queue.length) {
      const { fn, resolve } = queue.shift();
      active++;
      fn().then(resolve).catch(() => resolve({ ok: false })).finally(() => { active--; pump(); });
    }
  }

  /* ============================================================
     per-post processing
     ============================================================ */
  async function processPost(box) {
    if (!settings.enabled || box.dataset.iaratDone || !box.parentNode) return;

    const text = extractText(box);
    if (text.length < MIN_TEXT_LEN) { box.dataset.iaratDone = "skip"; return; }

    box.dataset.iaratDone = "1";
    const h = hashText(text);

    // a "…more" toggle living OUTSIDE the text box must be hidden alongside it
    const sm = box.parentElement ? box.parentElement.querySelector(SEL.seeMore) : null;
    const extraHide = sm && !box.contains(sm) ? sm : null;

    const meta = { flag: flagFor(text), aiScore: aiScore(text), savedTime: readTime(text) };
    const parts = buildCard(meta);
    box.parentNode.insertBefore(parts.root, box);
    box.classList.add("iarat-collapsed");
    if (extraHide) extraHide.classList.add("iarat-collapsed");
    wireToggle(parts, box, extraHide);

    if (!countedThisSession.has(h)) { countedThisSession.add(h); bumpCounter(); }

    if (memCache[h]) { setTldr(parts, memCache[h]); return; }

    const resp = await enqueue(() => requestSummary(text));
    if (resp && resp.ok && resp.tldr) {
      setTldr(parts, resp.tldr);
      memCache[h] = resp.tldr;
      cacheDirty = true;
      scheduleFlush();
    } else {
      setError(parts);
    }
  }

  function scan() {
    if (!ctxValid()) { teardown(); return; }
    if (!settings.enabled) return;
    document.querySelectorAll(SEL.textBox).forEach((box) => {
      if (!box.dataset.iaratDone) processPost(box);
    });
  }

  /* remove every injected card + un-hide originals (master off) */
  function removeAll() {
    document.querySelectorAll(".iarat-summary").forEach((c) => c.remove());
    document.querySelectorAll(".iarat-collapsed").forEach((e) => e.classList.remove("iarat-collapsed"));
    document.querySelectorAll("[data-iarat-done]").forEach((e) => { delete e.dataset.iaratDone; });
  }

  function reThemeAll() {
    document.querySelectorAll(".iarat-summary").forEach(applyTheme);
  }

  /* ============================================================
     observer (virtualized, infinite-scroll feed)
     ============================================================ */
  let scanTimer = null;
  let observer = null;
  function teardown() {
    if (observer) { observer.disconnect(); observer = null; }
    if (scanTimer) { clearTimeout(scanTimer); scanTimer = null; }
  }
  function scheduleScan() {
    if (!ctxValid()) { teardown(); return; } // orphaned — stop doing work
    if (scanTimer) return;
    scanTimer = setTimeout(() => { scanTimer = null; scan(); }, 300);
  }
  function startObserver() {
    const target = document.querySelector(SEL.feed) || document.body;
    observer = new MutationObserver(() => scheduleScan());
    observer.observe(target, { childList: true, subtree: true });
  }

  /* ============================================================
     settings + live updates
     ============================================================ */
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "sync") {
      if (changes.tone) settings.tone = changes.tone.newValue;
      if (changes.accent) { settings.accent = changes.accent.newValue || DEFAULT_ACCENT.slice(); reThemeAll(); }
      if (changes.cardStyle) { settings.cardStyle = changes.cardStyle.newValue || "filled"; reThemeAll(); }
      if (changes.enabled) {
        settings.enabled = changes.enabled.newValue;
        if (settings.enabled) scan(); else removeAll();
      }
    }
  });

  async function init() {
    const [sync, local] = await Promise.all([
      chrome.storage.sync.get(["enabled", "tone", "accent", "cardStyle"]),
      chrome.storage.local.get([CACHE_KEY]),
    ]);
    settings.enabled = sync.enabled ?? true;
    settings.tone = sync.tone ?? "brutal";
    settings.accent = sync.accent ?? DEFAULT_ACCENT.slice();
    settings.cardStyle = sync.cardStyle ?? "filled";
    memCache = local[CACHE_KEY] || {};

    startObserver();
    scan();
  }

  init();
})();
