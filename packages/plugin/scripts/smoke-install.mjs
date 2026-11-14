// 설치본 연기 시험 (이슈 #105) — 빌드된 dist/main.js 를 **그대로** 싣고 onload 를 돌린다.
//
// 왜 필요한가: 단위 시험은 src 를 보고, grep 은 바이트를 본다. 설치본이 실제로 서는지는
// 「번들을 require 해서 플러그인을 켜 본다」만이 답한다 — 마켓 설치본에서 깨졌던 자리(외부
// wasm 파일 의존)가 바로 그 층에 있었다. 옵시디언 API 는 최소 스텁으로 세운다: 네트워크
// (requestUrl)는 부르면 던지는 스텁이라, 기본값에서 외부 전송이 0 이라는 것이 여기서 증명된다.
//
// 돌리기: pnpm --filter @ontoflow/plugin build && pnpm --filter @ontoflow/plugin smoke
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dist = new URL("../dist/", import.meta.url);
const fail = (msg) => {
  console.error(`✗ ${msg}`);
  process.exitCode = 1;
};
const ok = (msg) => console.log(`✓ ${msg}`);

// ---- 옵시디언 API 최소 스텁 — onload 가 닿는 표면만 ----
const OBSIDIAN_STUB = `
const notices = [];
const net = { calls: [] };
class Plugin {
  constructor(app, manifest) { this.app = app; this.manifest = manifest; this.commands = []; this.eventCount = 0; }
  async loadData() { return this._data ?? null; }
  async saveData(d) { this._data = d; }
  addCommand(c) { this.commands.push(c); return c; }
  addSettingTab(t) { this.settingTab = t; }
  registerEvent() { this.eventCount++; }
  registerInterval(id) { return id; }
}
class PluginSettingTab { constructor(app, plugin) { this.app = app; this.plugin = plugin; } }
class Modal { constructor(app) { this.app = app; } open() {} close() {} }
class Notice { constructor(msg) { notices.push(String(msg)); } }
class TFile {}
class Setting {
  constructor() {}
  setName() { return this; } setDesc() { return this; } setHeading() { return this; }
  addText() { return this; } addButton() { return this; } addDropdown() { return this; }
}
function requestUrl(req) {
  net.calls.push(req.url);
  throw new Error("연기 시험: 기본값에서 네트워크를 불렀다 — " + req.url);
}
function base64ToArrayBuffer(b64) {
  const buf = Buffer.from(b64, "base64");
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}
function normalizePath(p) { return p; }
module.exports = { Plugin, PluginSettingTab, Modal, Notice, TFile, Setting,
  requestUrl, base64ToArrayBuffer, normalizePath, __notices: notices, __net: net };
`;

// ---- 메모리 vault 어댑터 — 옵시디언 DataAdapter 의 구조적 부분집합 ----
function memoryVault() {
  const files = new Map();
  const dirs = new Set();
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const adapter = {
    exists: async (p) => files.has(p) || dirs.has(p),
    read: async (p) => {
      if (!files.has(p)) throw new Error(`없는 파일: ${p}`);
      return dec.decode(files.get(p));
    },
    readBinary: async (p) => {
      if (!files.has(p)) throw new Error(`없는 파일: ${p}`);
      const b = files.get(p);
      return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
    },
    write: async (p, d) => void files.set(p, enc.encode(d)),
    writeBinary: async (p, d) => void files.set(p, new Uint8Array(d)),
    mkdir: async (p) => void dirs.add(p),
    rename: async (from, to) => {
      files.set(to, files.get(from));
      files.delete(from);
    },
    remove: async (p) => void files.delete(p),
  };
  return { adapter, files, dirs };
}

// ---- 설치 — 릴리스 산출물을 vault 의 플러그인 자리에 둔다 (README 의 그 경로) ----
const root = await mkdtemp(join(tmpdir(), "ontoflow-smoke-"));
const pluginDir = join(root, "vault", ".obsidian", "plugins", "ontoflow");
await mkdir(pluginDir, { recursive: true });
await mkdir(join(root, "node_modules", "obsidian"), { recursive: true });
await writeFile(join(root, "node_modules", "obsidian", "index.js"), OBSIDIAN_STUB);
await writeFile(
  join(root, "node_modules", "obsidian", "package.json"),
  JSON.stringify({ name: "obsidian", version: "0.0.0-stub", main: "index.js" }),
);

const manifest = JSON.parse(await readFile(new URL("manifest.json", dist), "utf8"));
const bundle = await readFile(new URL("main.js", dist));
await writeFile(join(pluginDir, "main.js"), bundle);
await writeFile(join(pluginDir, "manifest.json"), JSON.stringify(manifest, null, 2));
ok(`설치: .obsidian/plugins/${manifest.id}/ ← main.js (${(bundle.length / 1024).toFixed(0)}KB) · manifest.json`);

// ---- 적재 — 설치된 번들을 그 자리에서 require 한다 ----
const require = createRequire(join(root, "harness.cjs"));
const obsidian = require("obsidian");
const loaded = require(join(pluginDir, "main.js"));
const PluginClass = loaded.default ?? loaded;
if (typeof PluginClass !== "function") fail("번들이 플러그인 클래스를 내보내지 않는다");
else ok("번들 적재 — 플러그인 클래스가 선다");

// ---- 켜기 — 노트 둘이 든 vault 에서 onload ----
const vault = memoryVault();
// 노트는 실제 TFile 인스턴스여야 한다 — 플러그인의 reader 가 instanceof 로 거른다.
// 번들과 이 하네스는 같은 obsidian 스텁 모듈을 공유하므로(require 캐시) instanceof 가 성립한다.
const note = (path, body, mtime) =>
  Object.assign(new obsidian.TFile(), { path, extension: "md", stat: { mtime, size: body.length }, body });
const notes = [
  note("A.md", "# A\n\n[[B]] 를 지지한다.\n", 1),
  note("B.md", "# B\n\n받치는 노트.\n", 2),
];
const layoutCallbacks = [];
const app = {
  vault: {
    adapter: vault.adapter,
    getMarkdownFiles: () => notes,
    getAbstractFileByPath: (p) => notes.find((n) => n.path === p) ?? null,
    cachedRead: async (f) => notes.find((n) => n.path === f.path)?.body ?? "",
    on: () => ({}),
  },
  workspace: {
    onLayoutReady: (cb) => layoutCallbacks.push(cb),
    getActiveFile: () => null,
    openLinkText: () => {},
  },
};

const plugin = new PluginClass(app, { ...manifest, dir: pluginDir });
await plugin.onload();
ok(`onload — 커맨드 ${plugin.commands.length}개 · 설정 탭 ${plugin.settingTab ? "1" : "0"}`);

for (const cb of layoutCallbacks) cb();
// startUp 은 void 비동기다 — 정착을 기다린다.
for (let i = 0; i < 50 && !vault.files.has(".ontoflow/graph.sqlite"); i++) {
  await new Promise((r) => setTimeout(r, 20));
}

// ---- 판정 ----
if (vault.files.has(".ontoflow/graph.sqlite")) {
  const bytes = vault.files.get(".ontoflow/graph.sqlite");
  const header = Buffer.from(bytes.slice(0, 15)).toString("latin1");
  if (header.startsWith("SQLite format 3")) {
    ok(`정본이 섰다 — .ontoflow/graph.sqlite (${bytes.length}B, 표준 SQLite 헤더) · 내장 wasm 으로`);
  } else {
    fail(`graph.sqlite 가 SQLite 가 아니다: ${JSON.stringify(header)}`);
  }
} else {
  fail("정본(.ontoflow/graph.sqlite)이 서지 않았다 — wasm 적재 실패 가능");
}

// ---- 허브 없이 서는 무료 로컬 범위 (#105 — 내보내기는 로컬·무료가 v1 집합의 약속이다) ----
const run = async (id) => {
  const cmd = plugin.commands.find((c) => c.id === id);
  if (!cmd) {
    fail(`커맨드가 없다: ${id}`);
    return;
  }
  cmd.callback();
  await new Promise((r) => setTimeout(r, 200));
};

await run("export-jsonld");
await run("export-graphml");
for (const [file, probe] of [
  ["ontoflow-export.jsonld", "@context"],
  ["ontoflow-export.graphml", "graphml"],
]) {
  const bytes = vault.files.get(file);
  if (!bytes) {
    fail(`내보내기가 서지 않았다: ${file}`);
    continue;
  }
  const text = new TextDecoder().decode(bytes);
  if (!text.includes(probe)) fail(`${file} 의 꼴이 아니다 (${probe} 없음)`);
  else ok(`허브 없이 내보내기 — ${file} (${text.length}B)`);
}

// 주간 리포트(재부상)도 로컬 판정이다 — 허브 왕복 0.
await run("weekly-report");
ok("주간 리포트 강제 실행 — 허브 왕복 0");

// 기본 경로에서는 실패 알림이 한 건도 서지 않아야 한다 — wasm 이든 시작이든 내보내기든.
const badNotice = obsidian.__notices.find((n) => /실패|failed|wasm/i.test(n)); // en 기본 로케일 동반 (ISSUE-368)
if (badNotice) fail(`실패 알림이 섰다: ${badNotice}`);
else ok("실패·wasm 알림 0 — 조용히 선다");

if (obsidian.__net.calls.length > 0) {
  fail(`기본값에서 외부 전송이 있었다: ${obsidian.__net.calls.join(", ")}`);
} else {
  ok("기본 설정(허브 미설정·동의 전) — 외부 전송 0");
}

// ---- 재활성화 — 비활성→활성이 모듈 자리를 유지하는 경우를 흉내 낸다: 같은 번들 자리에서
// onload 를 또 돈다. wasm 주입이 멱등하지 않으면 코어가 「이미 초기화됐다」로 던지고 두 번째
// onload 가 통째로 넘어간다 (예전 try/catch 가 가려 주던 자리다) ----
try {
  const again = new PluginClass(app, { ...manifest, dir: pluginDir });
  await again.onload();
  ok(`재활성화 — 두 번째 onload 가 선다 (커맨드 ${again.commands.length}개)`);
} catch (e) {
  fail(`두 번째 onload 가 던졌다 — 비활성→활성이 깨진다: ${e.message}`);
}

const ids = plugin.commands.map((c) => c.id);
if (ids.some((id) => id.startsWith(manifest.id))) fail(`커맨드 id 가 플러그인 id 로 시작한다: ${ids}`);
else ok(`커맨드 id 중복 접두 0 — ${ids.join(", ")}`);

if (obsidian.__notices.length > 0) {
  console.log(`  (알림 ${obsidian.__notices.length}건: ${obsidian.__notices.join(" | ")})`);
}
console.log(process.exitCode ? "\n연기 시험 실패" : "\n연기 시험 통과 — 설치본이 그 자리에서 선다");
