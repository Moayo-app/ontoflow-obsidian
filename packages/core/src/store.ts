// 정본 SQLite (F4) — 사용자 자리의 그래프 DB. DDL 의 정본은 스펙(#1 「데이터 계약 — SQLite 정본」).
// 자리는 그래프 홈 — 기본값은 vault 안 `.ontoflow/` (설계 결정 ⓐ: vault 복사 = 그래프·어휘·투영
// 상태 통째 이동), 사용자가 다른 자리를 지정할 수 있다 (이슈 #31 — resolveHome·home.ts).
// sql.js(WASM) 를 쓴다: 옵시디언 플러그인은 네이티브 모듈을 못 싣고, 산출 파일은 표준 SQLite
// 포맷이라 BYOAI 정본 직결(어느 도구로든 직접 연다)이 그대로 성립한다. 디스크 원자성은
// 임시 파일 + rename 으로 진다.
import initSqlJs, { type Database, type SqlJsStatic } from "sql.js";
import { SEED_REGISTRY, serializeRegistry, verbEnum, type Registry } from "./registry.js";

export const ONTOFLOW_DIR = ".ontoflow";
export const DB_FILE = "graph.sqlite";
export const REGISTRY_FILE = "registry.yml";
export const SCHEMA_VERSION = 1;

// 파일 접근의 최소 표면 — 플러그인은 옵시디언 DataAdapter 로, 테스트·CLI 는 node:fs 로 구현한다.
export interface FileIo {
  readBinary(path: string): Promise<Uint8Array | null>;
  writeBinary(path: string, data: Uint8Array): Promise<void>;
  readText(path: string): Promise<string | null>;
  writeText(path: string, text: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  mkdir(path: string): Promise<void>;
  /** 없는 경로의 제거는 무해한 무연산이어야 한다 — 홈 이동(#31)의 원위치·정리가 기댄다. */
  remove(path: string): Promise<void>;
  /** vault 밖 경로에 닿는 구현인가. 옵시디언 DataAdapter 는 vault 한정 — 기본값 false (이슈 #31 AC6). */
  reachesOutsideVault?: boolean;
}

export class StoreError extends Error {
  constructor(readonly problems: string[]) {
    super(`정본 적용 실패:\n- ${problems.join("\n- ")}`);
    this.name = "StoreError";
  }
}

// ---- 그래프 홈 해석 (이슈 #31) — 정본·등록부·상태 파일이 앉는 디렉터리 ----
// 기본값은 vault 안 `.ontoflow/` (설계 결정 ⓐ). 포인터(`.ontoflow/home.json`)가 있으면
// 사용자 지정 자리다. 지정 홈은 designateHome(home.ts — 이동)으로만 생기므로 등록부가
// 그 자리의 생존 표지다: 등록부 없는 지정 홈 = 소실, 명시 오류 (임의 보정 0 — AC4).
// 모든 상태 모듈(store·collect·review·onboarding)은 경로를 직접 조립하지 않고 이 해석을 쓴다.

export const HOME_POINTER_FILE = "home.json";

export interface GraphHome {
  dir: string;
  designated: boolean;
  /** 홈이 vault 안이면 vault 상대 경로(수집 제외의 근거 — AC5), 밖이면 null. */
  rel: string | null;
}

// vault 상대 경로 — `..` 세그먼트는 보수적으로 밖으로 친다. vault 루트 자신은 "" 다.
export function vaultRelative(vaultDir: string, dir: string): string | null {
  if (dir.split("/").includes("..")) return null;
  const v = vaultDir.replace(/\/+$/, "");
  if (v === "" || v === ".") return dir.startsWith("/") ? null : dir;
  if (dir === v) return "";
  return dir.startsWith(`${v}/`) ? dir.slice(v.length + 1) : null;
}

export async function resolveHome(io: FileIo, vaultDir: string): Promise<GraphHome> {
  const defaultDir = `${vaultDir}/${ONTOFLOW_DIR}`;
  const text = await io.readText(`${defaultDir}/${HOME_POINTER_FILE}`);
  if (text === null) return { dir: defaultDir, designated: false, rel: ONTOFLOW_DIR };
  let home: unknown;
  try {
    home = (JSON.parse(text) as { home?: unknown }).home;
  } catch {
    throw new StoreError([`홈 포인터가 JSON 이 아니다 (${ONTOFLOW_DIR}/${HOME_POINTER_FILE}) — 임의 보정 0`]);
  }
  if (typeof home !== "string" || home.trim() === "") {
    throw new StoreError([`홈 포인터의 home 이 경로가 아니다 (${ONTOFLOW_DIR}/${HOME_POINTER_FILE}) — 임의 보정 0`]);
  }
  const dir = home.replace(/\/+$/, "");
  // AC4 — 지정 홈이 사라졌으면(이동·삭제, 또는 vault 밖을 못 가는 FileIo) 조용히 새 정본을
  // 만들지 않는다. 되돌리거나 다시 지정하는 건 사용자 몫이다.
  if ((await io.readText(`${dir}/${REGISTRY_FILE}`)) === null) {
    throw new StoreError([
      `지정 홈이 사라졌다: ${dir} — 새 정본을 임의로 만들지 않는다. 홈을 되돌리거나 다시 지정하라`,
    ]);
  }
  return { dir, designated: true, rel: vaultRelative(vaultDir, dir) };
}

// 엣지 계약 (스펙 「데이터 계약 — 엣지」). s·o 는 이름으로 들어와 노드 id 로 해석된다.
export interface EdgeWrite {
  s: string;
  v: string;
  o: string;
  confidence: number;
  fallback: boolean;
  by: "auto" | "user";
  src: { note: string | null; origin: "extract" | "wikilink" | "manual" };
}

export interface EdgeRetract {
  s: string;
  v: string;
  o: string;
  note: string | null;
}

export interface Patch {
  add: EdgeWrite[];
  retract: EdgeRetract[];
}

export interface GraphStore {
  db: Database;
  io: FileIo;
  /** graph.sqlite 경로. null 이면 아직 디스크에 매이지 않은 재색인 작업본이다. */
  path: string | null;
}

const DDL = `
CREATE TABLE nodes(
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK(kind IN ('file','concept')),
  path TEXT,
  props TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE aliases(node_id TEXT NOT NULL, alias TEXT NOT NULL, PRIMARY KEY(node_id, alias));
CREATE TABLE edges(
  id TEXT PRIMARY KEY,
  s TEXT NOT NULL, v TEXT NOT NULL, o TEXT NOT NULL,
  confidence REAL NOT NULL CHECK(confidence BETWEEN 0 AND 1),
  fallback INTEGER NOT NULL DEFAULT 0,
  by TEXT NOT NULL CHECK(by IN ('auto','user')),
  src_note TEXT,
  src_lost INTEGER NOT NULL DEFAULT 0,
  origin TEXT NOT NULL CHECK(origin IN ('extract','wikilink','manual'))
);
CREATE UNIQUE INDEX ux_edges_logical ON edges(s, v, o, src_note);
CREATE TABLE projections(
  dest TEXT NOT NULL CHECK(dest IN ('notion','postgres')),
  local_id TEXT NOT NULL, remote_id TEXT NOT NULL, synced_at TEXT NOT NULL,
  PRIMARY KEY(dest, local_id)
);
CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS distinctions(a TEXT NOT NULL, b TEXT NOT NULL, PRIMARY KEY(a, b));
CREATE TABLE IF NOT EXISTS shares(
  kind TEXT NOT NULL CHECK(kind IN ('note','node')),
  ref TEXT NOT NULL,
  shared_at TEXT NOT NULL,
  PRIMARY KEY(kind, ref)
);
`;
// 스펙 발췌 밖 추가 넷, 전부 가산적이다: edges.src_lost 는 출처 소실 표시(이슈 AC3 —
// by:user 보존의 표시 자리), ux_edges_logical 은 같은 노트의 같은 트리플 중복 방지,
// distinctions 는 정규화(#9)의 사용자 분리 판정 박제 — 같은 쌍 재병합 제안 0 의 근거다.
// 쌍은 사전순 (a < b) 으로 저장된다. shares 는 공유 1비트(ISSUE-234 · 질의 모델 #191 ⑦) —
// 멤버의 명시 행위만 선다(기본 비공유). 판단 레이어라 재추출로 되살아나지 않는다.

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function ulid(now = Date.now()): string {
  let time = "";
  let t = now;
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const rand = crypto.getRandomValues(new Uint8Array(16));
  let out = "";
  for (let i = 0; i < 16; i++) out += CROCKFORD[(rand[i] as number) % 32];
  return time + out;
}

let sqlJs: Promise<SqlJsStatic> | null = null;

// ---- wasm 위치 주입 자리 (이슈 #49, 가산) — Node 는 sql.js 가 wasm 을 스스로 찾지만,
// 번들된 플러그인 런타임은 못 찾는다: 플러그인이 자기 디렉터리의 wasm 을 일러 준다.
// 미주입 기본은 현행 동작 그대로다 (AC2) ----

export interface SqlJsConfig {
  /** wasm 바이너리 직접 주입 — 경로 해석(fetch) 자체를 건너뛴다: 번들 런타임의 정석. */
  wasmBinary?: ArrayBuffer;
  /** 또는 위치 함수 — sql.js 가 이 경로를 불러온다. */
  locateFile?: (file: string) => string;
}

let sqlJsConfig: SqlJsConfig = {};

export function configureSqlJs(config: SqlJsConfig): void {
  if (sqlJs !== null) {
    throw new StoreError(["sql.js 가 이미 초기화됐다 — wasm 주입은 첫 openVault 전이어야 한다"]);
  }
  sqlJsConfig = config;
}

function loadSqlJs(): Promise<SqlJsStatic> {
  sqlJs ??= initSqlJs(sqlJsConfig);
  return sqlJs;
}

/** 빈 작업본을 연다 (#63 PG 정본의 메모리 작업본 자리) — path null: persist 는 무연산이다. */
/**
 * 파일이 없는 자리의 FileIo — 작업본(path null · persist 무연산) 전용. 읽기는 전부 「없음」,
 * 쓰기는 명시 오류다: 작업본이 디스크에 닿으려 하면 설계 위반이라 바로 선다 (#81 허브 MCP).
 */
export const nullFileIo: FileIo = {
  readBinary: async () => null,
  readText: async () => null,
  async writeBinary() {
    throw new StoreError(["작업본 전용 io 다 — 디스크 쓰기는 설계 위반이다"]);
  },
  async writeText() {
    throw new StoreError(["작업본 전용 io 다 — 디스크 쓰기는 설계 위반이다"]);
  },
  async rename() {
    throw new StoreError(["작업본 전용 io 다 — 디스크 쓰기는 설계 위반이다"]);
  },
  async mkdir() {
    /* 무해 — 디렉터리 개념이 없다 */
  },
  async remove() {
    /* 무해한 무연산 */
  },
};

export async function openWorkingStore(io: FileIo): Promise<GraphStore> {
  const SQL = await loadSqlJs();
  return { db: newDb(SQL), io, path: null };
}

/**
 * 바이트에서 SQLite 를 연다 (#58 Bear 등 외부 로컬 DB 의 읽기 자리) — sql.js 는 메모리
 * 사본을 열므로 원본 파일에 쓰는 길이 구조적으로 없다: 읽기 전용의 실물이다.
 */
export async function openSqlDatabase(bytes: Uint8Array): Promise<Database> {
  const SQL = await loadSqlJs();
  return new SQL.Database(bytes);
}

function newDb(SQL: SqlJsStatic): Database {
  const db = new SQL.Database();
  db.exec(DDL);
  db.run("INSERT INTO meta(key, value) VALUES ('schema_version', ?)", [String(SCHEMA_VERSION)]);
  return db;
}

// vault 를 연다 — 그래프 홈(기본 `.ontoflow/`)과 정본·씨앗 등록부가 없으면 만든다 (설계 결정 ⓐ).
export async function openVault(io: FileIo, vaultDir: string): Promise<GraphStore> {
  const SQL = await loadSqlJs();
  const home = await resolveHome(io, vaultDir);
  const dir = home.dir;
  await io.mkdir(dir);
  const registryPath = `${dir}/${REGISTRY_FILE}`;
  if ((await io.readText(registryPath)) === null) {
    // 지정 홈의 등록부 부재는 resolveHome 이 이미 막았다 — 여기는 기본 홈의 첫 실행뿐이다.
    await io.writeText(registryPath, serializeRegistry(SEED_REGISTRY));
  }
  const dbPath = `${dir}/${DB_FILE}`;
  const bytes = await io.readBinary(dbPath);
  if (home.designated && bytes === null) {
    // AC4 의 반쪽 소실 — 지정 홈은 이동으로만 생기므로 정본 없는 지정 홈도 소실이다.
    throw new StoreError([
      `지정 홈에 정본(${DB_FILE})이 없다: ${dir} — 새 정본을 임의로 만들지 않는다`,
    ]);
  }
  const store: GraphStore = {
    db: bytes ? new SQL.Database(bytes) : newDb(SQL),
    io,
    path: dbPath,
  };
  if (bytes) {
    // 가산 마이그레이션 — distinctions·shares 이전의 정본도 그대로 연다 (스키마 버전 1 유지).
    store.db.exec(
      "CREATE TABLE IF NOT EXISTS distinctions(a TEXT NOT NULL, b TEXT NOT NULL, PRIMARY KEY(a, b))",
    );
    store.db.exec(
      "CREATE TABLE IF NOT EXISTS shares(kind TEXT NOT NULL CHECK(kind IN ('note','node')), ref TEXT NOT NULL, shared_at TEXT NOT NULL, PRIMARY KEY(kind, ref))",
    );
  } else {
    await persist(store);
  }
  return store;
}

// 디스크 반영 — 임시 파일 + rename. 실패하면 메모리를 디스크 상태로 되돌리고 던진다:
// 정본과 메모리가 갈라진 채 다음 패치를 받으면 안 된다 (이슈 AC2).
async function persist(store: GraphStore): Promise<void> {
  if (store.path === null) return;
  const tmp = `${store.path}.tmp`;
  try {
    await store.io.writeBinary(tmp, store.db.export());
    await store.io.rename(tmp, store.path);
  } catch (e) {
    const SQL = await loadSqlJs();
    const disk = await store.io.readBinary(store.path);
    store.db.close();
    store.db = disk ? new SQL.Database(disk) : newDb(SQL);
    throw e;
  }
}

function one(db: Database, sql: string, params: unknown[]): Record<string, unknown> | null {
  const stmt = db.prepare(sql);
  try {
    stmt.bind(params as never);
    return stmt.step() ? stmt.getAsObject() : null;
  } finally {
    stmt.free();
  }
}

// 이름 → 노드 id. 정규명 우선, 별칭 폴백 (#9 정규화가 별칭을 쌓는다).
function resolveNodeId(db: Database, name: string): string | null {
  const byName = one(db, "SELECT id FROM nodes WHERE name = ?", [name]);
  if (byName) return byName.id as string;
  const byAlias = one(db, "SELECT node_id FROM aliases WHERE alias = ?", [name]);
  return byAlias ? (byAlias.node_id as string) : null;
}

function ensureNodeId(db: Database, name: string): string {
  const found = resolveNodeId(db, name);
  if (found) return found;
  const id = ulid();
  // 미지의 이름은 개념 노드다 — 파일 실체화는 하지 않는다 (설계 결정 ⓑ).
  db.run("INSERT INTO nodes(id, name, kind) VALUES (?, ?, 'concept')", [id, name]);
  return id;
}

function validateEdge(verbs: Set<string>, e: EdgeWrite, i: number): string[] {
  const problems: string[] = [];
  if (!e.s?.trim() || !e.o?.trim()) problems.push(`add[${i}] 의 s·o 는 비어 있을 수 없다`);
  if (!verbs.has(e.v)) problems.push(`add[${i}] 의 동사가 등록부 밖이다: ${JSON.stringify(e.v)}`);
  if (typeof e.confidence !== "number" || e.confidence < 0 || e.confidence > 1) {
    problems.push(`add[${i}] 의 confidence 가 [0,1] 밖이다: ${JSON.stringify(e.confidence)}`);
  }
  if (e.by !== "auto" && e.by !== "user") problems.push(`add[${i}] 의 by 가 미지다`);
  if (!["extract", "wikilink", "manual"].includes(e.src?.origin)) {
    problems.push(`add[${i}] 의 origin 이 미지다`);
  }
  return problems;
}

export interface PatchResult {
  added: number;
  updated: number;
  skipped: number; // by:user 가 이겨서 건너뛴 add (충돌은 사용자 편집 항상 승 — moayo-hq#271 결의 10)
  retracted: number;
}

// add/retract 패치를 전검증 → 한 트랜잭션으로 적용 → 디스크 원자 반영한다 (이슈 AC1·AC2·AC6).
export async function applyPatch(
  store: GraphStore,
  registry: Registry,
  patch: Patch,
): Promise<PatchResult> {
  const verbs = new Set(verbEnum(registry));
  const problems = patch.add.flatMap((e, i) => validateEdge(verbs, e, i));
  if (problems.length > 0) throw new StoreError(problems);

  const result: PatchResult = { added: 0, updated: 0, skipped: 0, retracted: 0 };
  const db = store.db;
  db.exec("BEGIN");
  try {
    for (const e of patch.add) {
      const s = ensureNodeId(db, e.s.trim());
      const o = ensureNodeId(db, e.o.trim());
      const existing = one(
        db,
        "SELECT id, by FROM edges WHERE s = ? AND v = ? AND o = ? AND src_note IS ?",
        [s, e.v, o, e.src.note],
      );
      if (existing) {
        if (existing.by === "user" && e.by === "auto") {
          result.skipped++;
          continue;
        }
        db.run(
          "UPDATE edges SET confidence = ?, fallback = ?, by = ?, origin = ?, src_lost = 0 WHERE id = ?",
          [e.confidence, e.fallback ? 1 : 0, e.by, e.src.origin, existing.id as string],
        );
        result.updated++;
      } else {
        db.run(
          "INSERT INTO edges(id, s, v, o, confidence, fallback, by, src_note, origin) VALUES (?,?,?,?,?,?,?,?,?)",
          [ulid(), s, e.v, o, e.confidence, e.fallback ? 1 : 0, e.by, e.src.note, e.src.origin],
        );
        result.added++;
      }
    }
    for (const r of patch.retract) {
      const s = resolveNodeId(db, r.s.trim());
      const o = resolveNodeId(db, r.o.trim());
      if (s === null || o === null) continue; // 없는 엣지의 철회는 무해한 무연산이다
      // by:user 는 철회 대상이 아니다 — 사용자 편집 항상 승.
      db.run("DELETE FROM edges WHERE s = ? AND v = ? AND o = ? AND src_note IS ? AND by = 'auto'", [
        s,
        r.v,
        o,
        r.note,
      ]);
      result.retracted += db.getRowsModified();
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  await persist(store);
  return result;
}

// 노트 삭제 — 그 노트 출처의 by:auto 는 철회, by:user 는 출처 소실 표시로 보존한다 (이슈 AC3).
export async function retractNote(store: GraphStore, notePath: string): Promise<void> {
  const db = store.db;
  db.exec("BEGIN");
  try {
    db.run("DELETE FROM edges WHERE src_note = ? AND by = 'auto'", [notePath]);
    db.run("UPDATE edges SET src_lost = 1 WHERE src_note = ? AND by = 'user'", [notePath]);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  await persist(store);
}

// 파일 노드 — vault 파일 1:1 (설계 결정 ⓑ). 같은 이름의 개념 노드는 파일 노드로 승격된다.
export async function upsertFileNode(store: GraphStore, path: string, name: string): Promise<void> {
  store.db.run(
    "INSERT INTO nodes(id, name, kind, path) VALUES (?, ?, 'file', ?) ON CONFLICT(name) DO UPDATE SET kind = 'file', path = excluded.path",
    [ulid(), name, path],
  );
  await persist(store);
}

// 재색인 — 빈 작업본을 채운 뒤 정본을 원자 교체하고 버전을 meta 에 박는다 (이슈 AC7).
export async function rebuild(
  io: FileIo,
  vaultDir: string,
  versions: { registry: number; prompt: string },
  fill: (work: GraphStore) => Promise<void> | void,
): Promise<GraphStore> {
  const SQL = await loadSqlJs();
  const home = await resolveHome(io, vaultDir); // 지정 홈 소실이면 여기서 선다 — 재색인도 홈을 되살리지 않는다
  const work: GraphStore = { db: newDb(SQL), io, path: null };
  await fill(work);
  work.db.run("INSERT OR REPLACE INTO meta(key, value) VALUES ('registry_version', ?)", [
    String(versions.registry),
  ]);
  work.db.run("INSERT OR REPLACE INTO meta(key, value) VALUES ('prompt_version', ?)", [
    versions.prompt,
  ]);
  work.path = `${home.dir}/${DB_FILE}`;
  await persist(work);
  return work;
}

// ---- 정규화(F3)의 정본 면 — 별칭 축적·분리 박제·사전 적재 (#9) ----
// 판정 로직은 normalize.ts(허브 면, 무상태) 에 있고, 여기는 그 입출력이 앉는 자리다.

export interface DictionaryNode {
  name: string;
  aliases: string[];
}

// 허브는 무상태라 사전이 요청에 실려 간다 — 출처는 언제나 정본이다 (설계 결정 ⓐ).
export interface NormalizationDictionary {
  nodes: DictionaryNode[];
  distinctions: [string, string][]; // 사용자 분리 판정 — 사전순 쌍
}

const orderPair = (a: string, b: string): [string, string] => (a < b ? [a, b] : [b, a]);

export function loadDictionary(store: GraphStore): NormalizationDictionary {
  const byId = new Map<string, DictionaryNode>();
  const nodes: DictionaryNode[] = [];
  const nodeStmt = store.db.prepare("SELECT id, name FROM nodes ORDER BY name");
  while (nodeStmt.step()) {
    const row = nodeStmt.getAsObject();
    const node: DictionaryNode = { name: row.name as string, aliases: [] };
    byId.set(row.id as string, node);
    nodes.push(node);
  }
  nodeStmt.free();
  const aliasStmt = store.db.prepare("SELECT node_id, alias FROM aliases ORDER BY alias");
  while (aliasStmt.step()) {
    const row = aliasStmt.getAsObject();
    byId.get(row.node_id as string)?.aliases.push(row.alias as string);
  }
  aliasStmt.free();
  const distinctions: [string, string][] = [];
  const dStmt = store.db.prepare("SELECT a, b FROM distinctions ORDER BY a, b");
  while (dStmt.step()) {
    const row = dStmt.getAsObject();
    distinctions.push([row.a as string, row.b as string]);
  }
  dStmt.free();
  return { nodes, distinctions };
}

// 병합이 보존하는 표기들 — 별칭이 다른 노드에 이미 매였으면 거부한다 (해석 모호 금지).
export async function recordAliases(
  store: GraphStore,
  pairs: readonly { node: string; alias: string }[],
): Promise<void> {
  const problems: string[] = [];
  for (const [i, p] of pairs.entries()) {
    const alias = p.alias.trim();
    const node = p.node.trim();
    if (alias.length === 0 || node.length === 0) {
      problems.push(`aliases[${i}] 의 node·alias 는 비어 있을 수 없다`);
      continue;
    }
    if (alias === node) continue; // 자기 표기는 별칭이 아니다
    const nodeId = resolveNodeId(store.db, node);
    const aliasOwner = resolveNodeId(store.db, alias);
    if (aliasOwner !== null && aliasOwner !== (nodeId ?? "")) {
      problems.push(`aliases[${i}] 의 표기 「${alias}」 는 이미 다른 노드에 매여 있다`);
    }
  }
  if (problems.length > 0) throw new StoreError(problems);

  const db = store.db;
  db.exec("BEGIN");
  try {
    for (const p of pairs) {
      const alias = p.alias.trim();
      const node = p.node.trim();
      if (alias === node) continue;
      const nodeId = ensureNodeId(db, node);
      db.run("INSERT OR IGNORE INTO aliases(node_id, alias) VALUES (?, ?)", [nodeId, alias]);
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  await persist(store);
}

// 사용자 분리 판정의 박제 — 이 쌍은 다시 병합 제안되지 않는다 (이슈 #9 AC5).
export async function recordDistinction(store: GraphStore, a: string, b: string): Promise<void> {
  const [x, y] = orderPair(a.trim(), b.trim());
  if (x.length === 0 || y.length === 0 || x === y) {
    throw new StoreError(["분리 판정은 서로 다른 두 표기여야 한다"]);
  }
  store.db.run("INSERT OR IGNORE INTO distinctions(a, b) VALUES (?, ?)", [x, y]);
  await persist(store);
}

// ---- 투영 상태의 정본 면 (F9·F10) — 설계 결정 ⓒ: 투영 상태는 사용자 자리다 (#14) ----
// 원격 id 매핑과 실패 기록이 앉는 자리. 출고 판정 로직은 notion.ts(허브 면, 무상태)에 있다.

export type ProjectionDest = "notion" | "postgres";

// 투영 로컬 id 어휘 — 목적지 공통: projections.local_id 한 네임스페이스에 노드·엣지가 같이
// 서므로 접두사로 가른다. 제거 때 어느 쪽 원격 객체인지도 이 접두사가 말한다.
// ---- 공유 1비트 (ISSUE-234 · 질의 모델 #191 ⑦) — 판단 레이어: 재추출로 되살아나지 않는
// 명시 행위라 정본 테이블에 산다. 기본 비공유 — 비트가 없으면 조직 합집합(org-graph.ts)에
// 어떤 행도 실리지 않는다. 철회의 실체는 삭제 하나다: 합집합이 질의 시마다 재검사하므로
// (#191 ①·④ 「질의는 항상 현재 비트를 본다」) 별도 전파·sweep 창이 없다 ----

export type ShareKind = "note" | "node";

export interface ShareRecord {
  kind: ShareKind;
  ref: string;
  sharedAt: string;
}

export async function markShared(store: GraphStore, kind: ShareKind, ref: string, now: string): Promise<void> {
  const r = ref.trim();
  if (r.length === 0) throw new StoreError(["공유 대상이 비어 있다"]);
  if (kind === "node") {
    if (!one(store.db, "SELECT 1 AS ok FROM nodes WHERE id = ?", [r])) {
      throw new StoreError([`공유할 노드가 없다: ${r}`]);
    }
  } else if (
    !one(store.db, "SELECT 1 AS ok FROM edges WHERE src_note = ?", [r]) &&
    !one(store.db, "SELECT 1 AS ok FROM nodes WHERE path = ?", [r])
  ) {
    throw new StoreError([`공유할 노트가 그래프에 없다: ${r}`]);
  }
  store.db.run("INSERT INTO shares(kind, ref, shared_at) VALUES (?,?,?) ON CONFLICT(kind, ref) DO NOTHING", [
    kind,
    r,
    now,
  ]);
  await persist(store);
}

export async function retractShare(store: GraphStore, kind: ShareKind, ref: string): Promise<void> {
  if (!one(store.db, "SELECT 1 AS ok FROM shares WHERE kind = ? AND ref = ?", [kind, ref])) {
    throw new StoreError([`철회할 공유가 없다: ${kind} ${ref}`]);
  }
  store.db.run("DELETE FROM shares WHERE kind = ? AND ref = ?", [kind, ref]);
  await persist(store);
}

export function listShares(store: GraphStore): ShareRecord[] {
  const stmt = store.db.prepare("SELECT kind, ref, shared_at FROM shares ORDER BY kind, ref");
  try {
    const out: ShareRecord[] = [];
    while (stmt.step()) {
      const row = stmt.getAsObject() as { kind: ShareKind; ref: string; shared_at: string };
      out.push({ kind: row.kind, ref: row.ref, sharedAt: row.shared_at });
    }
    return out;
  } finally {
    stmt.free();
  }
}

export const nodeLocalId = (id: string): string => `node:${id}`;
export const edgeLocalId = (id: string): string => `edge:${id}`;

export interface ProjectionFailure {
  at: string; // 기록 시각 (ISO)
  localId: string; // 멈춘 항목
  status: number;
  retryAfterMs?: number;
}

export interface ProjectionState {
  mapping: Record<string, string>; // local_id → 원격 id
  failure: ProjectionFailure | null;
}

const failureKey = (dest: ProjectionDest): string => `projection:${dest}:failure`;

export function loadProjection(store: GraphStore, dest: ProjectionDest): ProjectionState {
  const mapping: Record<string, string> = {};
  const stmt = store.db.prepare("SELECT local_id, remote_id FROM projections WHERE dest = ?");
  try {
    stmt.bind([dest]);
    while (stmt.step()) {
      const row = stmt.getAsObject();
      mapping[row.local_id as string] = row.remote_id as string;
    }
  } finally {
    stmt.free();
  }
  const row = one(store.db, "SELECT value FROM meta WHERE key = ?", [failureKey(dest)]);
  if (row === null) return { mapping, failure: null };
  try {
    return { mapping, failure: JSON.parse(row.value as string) as ProjectionFailure };
  } catch {
    throw new StoreError([`투영 실패 기록이 손상됐다 (${failureKey(dest)}) — 임의 보정 0`]);
  }
}

// 출고 결과의 반영 — 새 매핑·동기 시각·제거·실패 기록을 한 트랜잭션으로 박는다 (이슈 #14 AC1).
// 성공 반영은 실패 기록을 지운다: 남은 실패 기록 = 재개할 일이 있다는 뜻 (AC3).
export interface ProjectionOutcome {
  newMappings: { localId: string; remoteId: string }[];
  syncedLocalIds: string[];
  removedLocalIds: string[];
  failure: ProjectionFailure | null;
}

export async function recordProjectionResult(
  store: GraphStore,
  dest: ProjectionDest,
  outcome: ProjectionOutcome,
  now: string,
): Promise<void> {
  const db = store.db;
  db.exec("BEGIN");
  try {
    for (const m of outcome.newMappings) {
      db.run(
        "INSERT OR REPLACE INTO projections(dest, local_id, remote_id, synced_at) VALUES (?, ?, ?, ?)",
        [dest, m.localId, m.remoteId, now],
      );
    }
    for (const localId of outcome.syncedLocalIds) {
      db.run("UPDATE projections SET synced_at = ? WHERE dest = ? AND local_id = ?", [
        now,
        dest,
        localId,
      ]);
    }
    for (const localId of outcome.removedLocalIds) {
      db.run("DELETE FROM projections WHERE dest = ? AND local_id = ?", [dest, localId]);
    }
    if (outcome.failure) {
      db.run("INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)", [
        failureKey(dest),
        JSON.stringify(outcome.failure),
      ]);
    } else {
      db.run("DELETE FROM meta WHERE key = ?", [failureKey(dest)]);
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  await persist(store);
}

// 자동 병합의 분리 — 별칭을 떼고 판정을 박제한다. 분리 확정 UI 와 엣지 재귀속은 검토 큐(S2) 몫.
export async function splitAlias(store: GraphStore, node: string, alias: string): Promise<void> {
  const nodeId = resolveNodeId(store.db, node.trim());
  if (nodeId === null) throw new StoreError([`분리할 노드가 없다: ${node}`]);
  const db = store.db;
  db.exec("BEGIN");
  try {
    db.run("DELETE FROM aliases WHERE node_id = ? AND alias = ?", [nodeId, alias.trim()]);
    if (db.getRowsModified() === 0) {
      throw new StoreError([`노드 「${node}」 에 별칭 「${alias}」 가 없다 — 분리할 병합이 없다`]);
    }
    const [x, y] = orderPair(node.trim(), alias.trim());
    db.run("INSERT OR IGNORE INTO distinctions(a, b) VALUES (?, ?)", [x, y]);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  await persist(store);
}
