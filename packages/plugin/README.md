# OntoFlow

[한국어](README.ko.md)

**Notes you wrote and forgot start talking back.** OntoFlow reads your vault and returns what it finds: claims that contradict each other, concepts with many links but no note to back them, and the same idea standing in different places — the machine organizes, you confirm.

Every finding is grounded in your own notes. One contradiction, one gap, one unexpected connection — from the first-index completion screen onward, everything you see comes from your notes. There are no made-up examples.

## What you get back

- **Insights** — contradictions (two notes refuting each other), gaps (a concept with many links but no backing note), and forgotten connections arrive in the review inbox and a weekly report. Every verdict is yours — nothing is applied automatically.
- **Grounded answers** — every finding links straight to its source notes.
- **Whichever LLM you use, the side that knows you is yours** — external AIs like Claude or GPT ride on top of your knowledge through MCP. You are not tied to any vendor.
- **You own it** — your database lives in your place: SQLite inside the vault (default) or a PostgreSQL you own. Export everything as JSON-LD or GraphML at any time, locally, for free.
- **Privacy options** — the default is hosted processing with zero retention (no content is stored). If you prefer, bring your own endpoint: process only with a local model on your machine (Ollama, vLLM, LM Studio) so note content never leaves the device.

The engine behind all of this is a knowledge graph of closed verbs — notes connect by meaning (supports, refutes, is part of, causes…), not just links, and every machine suggestion waits for your confirmation in the review inbox. The graph is the engine, not the storefront: what you see are findings, not a picture.

## Getting started

1. Install the plugin → connect the hub — the free plan includes one initial index, 30 credits a month, and the weekly report.
2. Pick a vault → consent to sensitive-data processing → start indexing.
3. On the completion screen, see three findings drawn from your own notes — start there.

Notes outside Obsidian (plain Markdown folders, Logseq, Bear, OneNote, Evernote, Notion, Google Drive, Dropbox, GitLab, GitHub, Jira, Confluence) join the import with a single **Connect** button in the hub console — no token juggling (only Notion takes an internal integration token). Connected API sources are pulled incrementally when the plugin starts and by the **Catch up import sources** command — there is nothing else to register: connecting is registering.

## Install

Community-plugin listing is pending. Until then, install by hand — it is only two files.

1. Download `main.js` and `manifest.json` from the [releases](https://github.com/Moayo-app/OntoFlow/releases).
2. Create `.obsidian/plugins/ontoflow/` inside your vault and put both files there.

   ```
   <your vault>/.obsidian/plugins/ontoflow/
   ├── main.js
   └── manifest.json
   ```

3. Obsidian → Settings → Community plugins → **Reload** installed plugins → enable **OntoFlow**.
4. Connect the hub — in the [hub console](https://hub.ontoflow.app/console) under **Account**, issue an **API key** (`ofk_…` — shown only once) and paste it into the plugin settings along with the hub address (`https://hub.ontoflow.app`). Keys do not expire; if you lose one, revoke it in the console and issue a new one.

The minimum Obsidian version is 1.5.0. Desktop and mobile both work — importing folders outside the vault (plain Markdown, Logseq, synced folders) and Bear need filesystem access and are desktop-only; on mobile those items are announced explicitly rather than silently missing.

## Network & privacy notice

**The default is zero outbound traffic.** Installing and enabling the plugin sends nothing — until you enter a hub address and API key and complete the sensitive-data consent, your notes never leave the device. The plugin has **no telemetry, no analytics, no ads**, and no path that downloads and runs remote code (even the SQLite engine's wasm is bundled).

After you connect, it talks to these places only:

| Where | What | When |
| --- | --- | --- |
| Moayo hub (the address you enter in settings) | Note content to extract, structured results | During indexing and import. The hub **keeps no content** (zero retention) |
| BYO endpoint (the address you enter) | Note content to extract | When you configure BYO. In that case content **never leaves your machine** |
| Your own PostgreSQL (via the hub) | Your graph database | When you choose `pg` as your database |

- **Lives only in your place**: the hub API key and BYO API key exist only in this plugin's settings store (`data.json`) and flow only as call headers — never in note content, logs, or error messages.
- **External source connections** (OneNote, Evernote, Google Drive, Dropbox) finish their OAuth in the hub console — tokens go straight to the vault-side credential store and **this plugin never sees them**. The settings-tab buttons just open that page in your browser.
- **Account**: ontology extraction (indexing and import) needs a hub account — a free plan exists with no time limit. What works without an account is exactly the line below.
- **Payment**: extraction beyond the free plan's monthly allowance needs a paid plan. Prices live on the plans page at [ontoflow.app](https://ontoflow.app) — there is no payment inside this plugin.
- **What works without the hub**: browsing your database, JSON-LD/GraphML export, the weekly report (insight verdicts), and local MCP are all local — no network needed. Export is local and free — the door out is always open.
