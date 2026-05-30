# I ain't reading all that

A lightweight Chrome (Manifest V3) extension that auto-summarizes posts in your
LinkedIn feed into a short, snarky one-line **TL;DR** and collapses the original
post (text **and** images/embeds) behind a `read all that (if you must)` toggle.

You bring your own AI API key — **DeepSeek, OpenAI, Claude (Anthropic), or
Gemini** — one provider active at a time. Without a key it runs in demo mode so
you can see the UI.

## Features

- **One-line TL;DR** injected at the top of each text post; the original body
  collapses behind a toggle.
- **Whole-post collapse** — hides text, images, and embeds, leaving the author
  header, the summary card, and the Like/Comment bar.
- **Snark level** — `Just the facts` or `Brutally honest`.
- **Themes** — Electric violet, Teal, Hot magenta, Graphite.
- **Card style** — Filled or Outline.
- **Flag + AI-likelihood chips** (e.g. `🚩 engagement bait`, `🤖 60% AI`) from a
  cheap client-side heuristic — no extra tokens.
- **Caching** — summaries are cached by a hash of the post text in
  `chrome.storage.local`, so re-scrolling the same post doesn't re-summarize.
- **Session counter** — "posts you didn't have to read this session."
- **Bundled fonts** (Bricolage Grotesque + Space Mono) embedded as `data:` URIs;
  works offline, no external requests.

## Install (Load unpacked)

1. Clone or download this repo.
2. Open `chrome://extensions`.
3. Toggle **Developer mode** on (top-right).
4. Click **Load unpacked** and select this folder (the one containing
   `manifest.json`).
5. Pin the violet **"I"** icon from the extensions menu.

After editing any source file: return to `chrome://extensions`, click **reload**
(↻) on the extension, then refresh your LinkedIn tab.

## Configure

Click the toolbar icon to open the popup:

1. **Summarize my feed** — master on/off. Flipping it injects/removes all cards
   live.
2. **Snark level** — controls the prompt tone.
3. **Theme** — recolors the popup and injected cards.
4. **Summary card** — Filled or Outline.
5. **AI provider** — pick one, paste its API key, and hit **Save**. Keys are
   stored per provider; only the selected one is used.

### Getting an API key

| Provider | Model | Get a key |
|---|---|---|
| DeepSeek | `deepseek-chat` | https://platform.deepseek.com/api_keys |
| OpenAI | `gpt-4o-mini` | https://platform.openai.com/api-keys |
| Claude (Anthropic) | `claude-3-5-haiku-latest` | https://console.anthropic.com/settings/keys |
| Gemini (Google) | `gemini-2.0-flash` | https://aistudio.google.com/app/apikey |

No key saved → the card shows demo lines so you can preview the design.

## How it works

```
content.js  → (post text) → chrome.runtime.sendMessage → service-worker.js
service-worker.js → fetch(provider endpoint, your key) → TL;DR string
service-worker.js → sendResponse → content.js renders the card
```

- The **content script** scrapes posts from the live LinkedIn DOM, injects the
  card, handles expand/collapse, caching, and theming. It uses a
  `MutationObserver` for the virtualized, infinite-scroll feed and a
  `data-iarat-done` marker so each post is processed once.
- The **service worker** is the only place that calls an AI provider — this
  keeps your key off the LinkedIn page and avoids CORS. It normalizes each
  provider's response shape down to a single string.

## Privacy

- Your API key lives in `chrome.storage.local` and is read only by the
  background service worker. It is never exposed to the LinkedIn page.
- Post text is sent only to the AI provider you configured, only to generate a
  summary. Summaries are cached locally to minimize repeat calls.
- No analytics, no telemetry, no external requests beyond the chosen provider.

## State (`chrome.storage`)

- **sync:** `enabled`, `tone` (`facts` | `brutal`), `accent` (4-color array),
  `cardStyle` (`filled` | `outline`), `provider`
- **local:** `keys` ({ deepseek, openai, claude, gemini }), `summaryCache`
  ({ hash: tldr }), `sessionCount`

## Project structure

```
.
├── manifest.json
├── content/
│   ├── content.js          # scrape, inject card, collapse/expand, cache, theme
│   └── content.css         # injected card styles (all classes iarat- prefixed)
├── background/
│   └── service-worker.js   # calls the active AI provider, returns the TL;DR
├── popup/
│   ├── popup.html          # settings UI
│   ├── popup.css
│   └── popup.js
├── fonts/                  # bundled woff2 + @font-face
│   └── fonts-data.css      # data:-URI fonts used by the injected card
└── icons/                  # 16 / 48 / 128 / 512 px
```

Vanilla JS + CSS, no build step.

## How it was built

- Designed and built with Claude. The design came first: Claude generated the HTML/React prototype and a Manifest V3 build brief (file layout, design tokens, the four provider request shapes).
- Claude Code built the extension from that brief in about five hours, tested against a live LinkedIn feed.
- Most of that time went to one problem: LinkedIn's feed uses scrambled, hashed class names now, so normal selectors are dead on arrival. The stable `data-testid` hooks turned up by poking at the live DOM in the console.
- Other bugs only showed up on the real site: fonts failing as `chrome-extension://invalid/`, a storage call that hung and froze the script, an observer watching the wrong node.
- No build step, no framework, no dependencies. Just vanilla Manifest V3 that loads as-is.

Tools:

- Claude — design (HTML/React prototype + build brief)
- Claude Code — built the extension
- Chrome DevTools — testing and selector hunting
- Google Fonts — Bricolage Grotesque, Space Mono
- git / GitHub — version control

## Notes

- **DOM selectors are brittle.** LinkedIn renames/obfuscates feed classes often,
  so the extension anchors on `data-testid` hooks (e.g.
  `[data-testid="expandable-text-box"]`). All selectors live in one `SEL` object
  at the top of `content/content.js` — update there if cards stop appearing.
- `chrome-extension://invalid/` spam in the console on LinkedIn is from
  LinkedIn's own ad cookie-sync being blocked by a content blocker, not from
  this extension.
