# OntoFlow

**Your forgotten notes start talking back.** OntoFlow reads your vault and returns
what you could not see: claims that contradict each other, concepts every note
links to but none explains, and the same idea written twice in different places.
The machine organizes. You decide.

Every finding is grounded in your own notes. One contradiction, one gap, one
unexpected connection: from the very first indexing screen, everything shown
comes from notes you wrote. No invented examples.

## What you get back

- **Insights** – contradictions (two notes arguing against each other), gaps
  (concepts with many links but no note behind them), and forgotten connections,
  delivered to a review inbox and a weekly report. Every judgment is yours to
  accept or reject. Nothing is applied automatically.
- **Grounded answers** – every finding links straight to the notes behind it.
- **Any LLM, your memory** – external AIs such as Claude or GPT connect to your
  knowledge over MCP. You are not locked into any vendor.
- **You own the database** – the canonical graph lives on your side: SQLite
  inside your vault (default) or a PostgreSQL you own. Export everything as
  JSON-LD or GraphML at any time, locally, for free.
- **Privacy options** – default is hosted processing with zero content
  retention. Prefer local? Bring your own endpoint (Ollama, vLLM, LM Studio)
  and note content never leaves your machine.

The engine behind all of this is a knowledge graph with a closed verb registry:
notes connect by meaning (supports, contradicts, is part of, causes, ...), and
every machine suggestion waits for your confirmation in the review inbox. The
graph is the engine, not the billboard: what you see are findings, not pictures.

## Getting started

1. Install the plugin and connect to the hub. The free plan includes one initial
   indexing, 30 credits per month, and the weekly report, with no time limit.
2. Choose your vault, give explicit consent for processing, and start indexing.
3. The completion screen shows findings from your own notes. Start there.

Notes outside Obsidian (plain Markdown folders, Logseq, Bear, OneNote, Evernote,
Google Drive, Dropbox) join through a single Connect button, with no manual
token setup.

## Installation

Install from the Obsidian community plugin directory, or manually: download
`main.js` and `manifest.json` from a release into
`<your vault>/.obsidian/plugins/ontoflow/`, then refresh and enable the plugin
under Settings → Community plugins.

Minimum Obsidian version: 1.5.0. Works on desktop and mobile. Collecting from
folders outside the vault (plain Markdown, Logseq, synced folders) and from
Bear requires file-system access and is desktop-only; on mobile those items
are explicitly marked unavailable rather than silently empty.

## Network and privacy disclosure

**By default, nothing leaves your device.** Installing and enabling the plugin
sends nothing anywhere. Until you enter a hub address and token and complete
the sensitive-data consent, your notes stay on this device. The plugin contains
**no telemetry, no analytics, no ads**, and no path that downloads and runs
remote code (even the SQLite engine's wasm is embedded in the bundle).

After you connect, the plugin talks only to:

| Where | What | When |
| --- | --- | --- |
| Moayo hub (the address you enter in settings) | Note content to extract, structured results | During indexing and collection. The hub keeps zero content (zero retention) |
| Your BYO endpoint (the address you enter) | Note content to extract | Only if you configure BYO. In this mode note content never leaves your machine |
| Your own PostgreSQL (via the hub) | The canonical graph | Only if you choose `pg` as the canonical store |

- **Account**: ontology extraction (indexing and collection) requires a hub
  account. A free plan is available with no time limit. Everything listed under
  "Works without the hub" below needs no account.
- **Payment**: extraction beyond the free plan's monthly credits requires a paid
  plan. Pricing lives on the plans page at [ontoflow.app](https://ontoflow.app).
  There is no payment inside this plugin.
- **Stays on your side**: hub tokens and BYO API keys live only in this
  plugin's settings store (`data.json`) and flow only as request headers. They
  never appear in note content, logs, or error messages.
- **External source connections** (OneNote, Evernote, Google Drive, Dropbox)
  complete their OAuth in the hub console. Tokens go straight to the vault
  there; **this plugin never sees them**. The settings button simply opens that
  page in your browser.
- **Works without the hub**: browsing the canonical graph, JSON-LD/GraphML
  export, the weekly report, and local MCP integration are all local and need
  no network. Export is local and free. The exit door is always open.

## License

Apache-2.0. See [LICENSE](LICENSE).

---

This repository is the public source of the OntoFlow Obsidian plugin: the
plugin itself plus the core modules its build needs. It is synced from the
OntoFlow monorepo. Issues and pull requests are welcome here.
