// PG 정본 (ISSUE-63) — 사용자 소유 PostgreSQL 을 정본 꼴로 승격한다 (#53 2차 결의 ②).
// 꼴: 「보관은 PG, 판정은 기존 작업본」 — 연산은 전부 기존 sql.js 판정 엔진(store.ts 등)의
// 메모리 작업본에서 돌고, 이 모듈은 PG ↔ 작업본의 적재(load)·반영(flush)만 든다. SQLite
// 정본과 같은 코드가 돌아서 등가(AC1)가 구조로 성립하고, 충돌 규칙(사용자 편집 항상 승 —
// AC2)도 applyPatch 그대로다.
//
// 경계: 이 모듈은 투영 클라이언트(postgres.ts — 쓰기 전용, 되읽기 0 구조 증명)와 물리적으로
// 분리된 **정본 경계**다 — 정본 조회는 되읽기가 아니라 정본의 본령이다. 두 모듈은 서로를
// 모른다. 스키마 분리(#53 조직 결의 ⓒ): 개인 `ontoflow`, 조직 구성원 `ontoflow_<구성원>` —
// 자리만 조직, 정본은 개인 소유 그대로.
//
// 반쪽 커밋 0 (AC5): flush 는 rev 낙관적 잠금 가드를 단 단일 트랜잭션 — 가드 불일치·전송
// 실패는 전량 롤백 + 명시 오류다. 모아요 보관 0 (AC3): 적재·반영 전부 사용자 PG 와 허브
// 처리 버퍼 사이만 오간다 — 허브에 앉는 영속 상태가 없다.
import { parseRegistry, serializeRegistry, SEED_REGISTRY, type Registry } from "./registry.js";
import { openWorkingStore, type FileIo, type GraphStore } from "./store.js";

export class PgStoreError extends Error {
  constructor(
    readonly status: number,
    readonly problems: string[],
  ) {
    super(`PG 정본 거부 (${status}):\n- ${problems.join("\n- ")}`);
    this.name = "PgStoreError";
  }
}

// ---- 스키마 이름 (#53 조직 결의 ⓒ) ----

/**
 * 개인 `ontoflow` 또는 조직 구성원 `ontoflow_<구성원>` — 그 밖은 최소 스코프 초과다.
 * ⚠️ 하이픈 불허 (#426) — 스키마는 SQL 에 비인용 식별자로 보간되는데 PostgreSQL 비인용
 * 식별자는 하이픈을 받지 않는다. 계정 id(UUID)의 하이픈은 memberSchema 가 접는다.
 */
export const CANONICAL_SCHEMA_SHAPE = /^ontoflow(_[a-z0-9][a-z0-9_]{0,60})?$/;

export function assertCanonicalSchema(schema: string): void {
  if (!CANONICAL_SCHEMA_SHAPE.test(schema)) {
    throw new PgStoreError(422, [
      `정본 스키마는 ontoflow 또는 ontoflow_<구성원> 꼴이어야 한다: ${JSON.stringify(schema)}`,
    ]);
  }
}

// ---- 멤버 스키마 (ISSUE-234 AC1) — 합류 확정(동의 포함) 시점의 자리 만들기 ----

/** 조직 공용 스키마 (#191 ② — 등록부·사건 로그의 자리). 멤버 스키마가 아니다. */
export const ORG_SCHEMA = "ontoflow_org";

/**
 * 계정 id → 멤버 스키마 이름. 규칙은 CANONICAL_SCHEMA_SHAPE 하나 + 공용 자리 예약이다.
 * 계정 id 는 UUID(하이픈 포함)라 그대로는 비인용 식별자가 못 된다 — 하이픈만 `_` 로 접는다
 * (#426 · 스키마 모양 결의 #53 ⓒ 무변). UUID 에는 `_` 가 없어 접힘이 충돌을 만들지 않는다.
 */
export function memberSchema(accountId: string): string {
  const id = accountId.trim().toLowerCase().replace(/-/g, "_");
  const schema = `ontoflow_${id}`;
  if (id.length === 0 || !CANONICAL_SCHEMA_SHAPE.test(schema)) {
    throw new PgStoreError(422, [`멤버 스키마를 만들 수 없는 계정 id 다: ${JSON.stringify(accountId)}`]);
  }
  if (schema === ORG_SCHEMA) {
    throw new PgStoreError(422, [`예약된 자리다 — ${ORG_SCHEMA} 는 조직 공용 스키마라 멤버가 쓸 수 없다`]);
  }
  return schema;
}

// ---- PG 세션 경계 — 정본이므로 읽기·쓰기 둘 다 있다 (투영 PgClient 와 별개 인터페이스) ----

export interface PgStatement {
  sql: string;
  params?: unknown[];
}

export interface PgCanonicalSession {
  query(sql: string, params?: unknown[]): Promise<Record<string, unknown>[]>;
  /**
   * 단일 트랜잭션 — 전부 아니면 전무. guard 가 있으면 트랜잭션 안에서 먼저 돌려
   * 행이 0 이면 전량 롤백하고 409 로 던진다 (rev 낙관적 잠금 — AC5).
   */
  transact(statements: readonly PgStatement[], guard?: PgStatement): Promise<void>;
}

// ---- 정본 덤프 — PG ↔ 작업본의 운반 꼴 ----

export const CANONICAL_DUMP_SCHEMA = 1;

export interface CanonicalDump {
  schema: typeof CANONICAL_DUMP_SCHEMA;
  /** 낙관적 잠금 카운터 — flush 는 이 값을 가드로 걸고 +1 한다. */
  rev: number;
  /** 동사 등록부 — 정본의 일부로 PG 에 산다 (AC4). vault 파일은 세션 작업 사본일 뿐이다. */
  registryYml: string;
  nodes: { id: string; name: string; kind: string; path: string | null; props: string }[];
  aliases: { node_id: string; alias: string }[];
  edges: {
    id: string;
    s: string;
    v: string;
    o: string;
    confidence: number;
    fallback: number;
    by: string;
    src_note: string | null;
    src_lost: number;
    origin: string;
  }[];
  distinctions: { a: string; b: string }[];
  projections: { dest: string; local_id: string; remote_id: string; synced_at: string }[];
  meta: { key: string; value: string }[];
  /** 공유 1비트 (ISSUE-234 · #191 ⑦) — 판단 레이어라 정본에 산다. 옛 덤프엔 없다: 부재 = 공유 0. */
  shares?: { kind: string; ref: string; shared_at: string }[];
}

function rows(store: GraphStore, sql: string): Record<string, unknown>[] {
  const stmt = store.db.prepare(sql);
  try {
    const out: Record<string, unknown>[] = [];
    while (stmt.step()) out.push(stmt.getAsObject() as Record<string, unknown>);
    return out;
  } finally {
    stmt.free();
  }
}

/** 작업본 → 덤프 — 결정적 순서(키 정렬)라 같은 상태는 같은 덤프다. */
export function dumpCanonical(store: GraphStore, registry: Registry, rev: number): CanonicalDump {
  return {
    schema: CANONICAL_DUMP_SCHEMA,
    rev,
    registryYml: serializeRegistry(registry),
    nodes: rows(store, "SELECT id, name, kind, path, props FROM nodes ORDER BY id") as CanonicalDump["nodes"],
    aliases: rows(store, "SELECT node_id, alias FROM aliases ORDER BY node_id, alias") as CanonicalDump["aliases"],
    edges: rows(
      store,
      "SELECT id, s, v, o, confidence, fallback, by, src_note, src_lost, origin FROM edges ORDER BY id",
    ) as CanonicalDump["edges"],
    distinctions: rows(store, "SELECT a, b FROM distinctions ORDER BY a, b") as CanonicalDump["distinctions"],
    projections: rows(
      store,
      "SELECT dest, local_id, remote_id, synced_at FROM projections ORDER BY dest, local_id",
    ) as CanonicalDump["projections"],
    meta: rows(store, "SELECT key, value FROM meta ORDER BY key") as CanonicalDump["meta"],
    shares: rows(store, "SELECT kind, ref, shared_at FROM shares ORDER BY kind, ref") as CanonicalDump["shares"],
  };
}

/** 덤프 → 작업본 — 기존 판정 엔진(applyPatch·projectionDataFor·…)이 그대로 도는 자리다. */
export async function restoreCanonical(
  io: FileIo,
  dump: CanonicalDump,
): Promise<{ store: GraphStore; registry: Registry }> {
  if (dump.schema !== CANONICAL_DUMP_SCHEMA) {
    throw new PgStoreError(422, [`덤프 스키마가 맞지 않는다 (기대 ${CANONICAL_DUMP_SCHEMA})`]);
  }
  const registry = parseRegistry(dump.registryYml);
  const store = await openWorkingStore(io);
  const db = store.db;
  db.exec("BEGIN");
  try {
    db.run("DELETE FROM meta"); // 빈 작업본의 씨앗 메타는 덤프가 대체한다
    for (const n of dump.nodes) {
      db.run("INSERT INTO nodes(id, name, kind, path, props) VALUES (?,?,?,?,?)", [
        n.id,
        n.name,
        n.kind,
        n.path,
        n.props,
      ]);
    }
    for (const a of dump.aliases) db.run("INSERT INTO aliases(node_id, alias) VALUES (?,?)", [a.node_id, a.alias]);
    for (const e of dump.edges) {
      db.run(
        "INSERT INTO edges(id, s, v, o, confidence, fallback, by, src_note, src_lost, origin) VALUES (?,?,?,?,?,?,?,?,?,?)",
        [e.id, e.s, e.v, e.o, e.confidence, e.fallback, e.by, e.src_note, e.src_lost, e.origin],
      );
    }
    for (const d of dump.distinctions) db.run("INSERT INTO distinctions(a, b) VALUES (?,?)", [d.a, d.b]);
    for (const pr of dump.projections) {
      db.run("INSERT INTO projections(dest, local_id, remote_id, synced_at) VALUES (?,?,?,?)", [
        pr.dest,
        pr.local_id,
        pr.remote_id,
        pr.synced_at,
      ]);
    }
    for (const m of dump.meta) db.run("INSERT INTO meta(key, value) VALUES (?,?)", [m.key, m.value]);
    for (const sh of dump.shares ?? []) {
      db.run("INSERT INTO shares(kind, ref, shared_at) VALUES (?,?,?)", [sh.kind, sh.ref, sh.shared_at]);
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return { store, registry };
}

// ---- PG DDL — 정본 테이블은 canonical_* 로, 투영 테이블(ontoflow.nodes/edges)과 같은
// 스키마에 있어도 충돌하지 않는다 ----

const TABLES = ["nodes", "aliases", "edges", "distinctions", "projections", "meta", "shares"] as const;

function ddl(schema: string): PgStatement[] {
  const s = schema;
  return [
    { sql: `CREATE SCHEMA IF NOT EXISTS ${s}` },
    {
      sql: `CREATE TABLE IF NOT EXISTS ${s}.canonical_nodes(
        id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, path TEXT, props TEXT NOT NULL DEFAULT '{}')`,
    },
    {
      sql: `CREATE TABLE IF NOT EXISTS ${s}.canonical_aliases(node_id TEXT NOT NULL, alias TEXT NOT NULL, PRIMARY KEY(node_id, alias))`,
    },
    {
      sql: `CREATE TABLE IF NOT EXISTS ${s}.canonical_edges(
        id TEXT PRIMARY KEY, s TEXT NOT NULL, v TEXT NOT NULL, o TEXT NOT NULL,
        confidence REAL NOT NULL, fallback INTEGER NOT NULL DEFAULT 0, by TEXT NOT NULL,
        src_note TEXT, src_lost INTEGER NOT NULL DEFAULT 0, origin TEXT NOT NULL)`,
    },
    { sql: `CREATE TABLE IF NOT EXISTS ${s}.canonical_distinctions(a TEXT NOT NULL, b TEXT NOT NULL, PRIMARY KEY(a, b))` },
    {
      sql: `CREATE TABLE IF NOT EXISTS ${s}.canonical_projections(
        dest TEXT NOT NULL, local_id TEXT NOT NULL, remote_id TEXT NOT NULL, synced_at TEXT NOT NULL, PRIMARY KEY(dest, local_id))`,
    },
    { sql: `CREATE TABLE IF NOT EXISTS ${s}.canonical_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL)` },
    {
      sql: `CREATE TABLE IF NOT EXISTS ${s}.canonical_shares(
        kind TEXT NOT NULL, ref TEXT NOT NULL, shared_at TEXT NOT NULL, PRIMARY KEY(kind, ref))`,
    },
    {
      // 수집함 (#81) — 원격 MCP 캡처의 보류함: 덤프·flush 전량 교체의 밖이다 (TABLES 비포함 —
      // 반영이 메일함을 지우지 않는다). 비우는 쪽은 플러그인(드레인 → vault 수집함)이다.
      sql: `CREATE TABLE IF NOT EXISTS ${s}.canonical_inbox(
        id TEXT PRIMARY KEY, title TEXT NOT NULL, md TEXT NOT NULL, captured_at TEXT NOT NULL)`,
    },
  ];
}

/** 멤버 스키마 프로비저닝 (AC1) — ddl 이 멱등이라 재호출·선적재와 무해하게 겹친다. */
export async function provisionMemberSchema(
  session: PgCanonicalSession,
  accountId: string,
): Promise<{ schema: string }> {
  const schema = memberSchema(accountId);
  await session.transact(ddl(schema));
  return { schema };
}

// ---- 적재 (PG → 덤프) ----

export async function loadCanonicalFromPg(session: PgCanonicalSession, schema: string): Promise<CanonicalDump> {
  assertCanonicalSchema(schema);
  await session.transact(ddl(schema)); // 빈 DB 의 첫 적재가 정본의 탄생이다 — 멱등
  const s = schema;
  const meta = (await session.query(`SELECT key, value FROM ${s}.canonical_meta ORDER BY key`)) as {
    key: string;
    value: string;
  }[];
  const metaMap = new Map(meta.map((m) => [m.key, m.value]));
  const rev = Number(metaMap.get("rev") ?? "0");
  if (!Number.isInteger(rev) || rev < 0) throw new PgStoreError(422, [`rev 가 수가 아니다: ${metaMap.get("rev")}`]);
  const registryYml = metaMap.get("registry_yml") ?? serializeRegistry(SEED_REGISTRY);
  return {
    schema: CANONICAL_DUMP_SCHEMA,
    rev,
    registryYml,
    nodes: (await session.query(
      `SELECT id, name, kind, path, props FROM ${s}.canonical_nodes ORDER BY id`,
    )) as CanonicalDump["nodes"],
    aliases: (await session.query(
      `SELECT node_id, alias FROM ${s}.canonical_aliases ORDER BY node_id, alias`,
    )) as CanonicalDump["aliases"],
    edges: (await session.query(
      `SELECT id, s, v, o, confidence, fallback, by, src_note, src_lost, origin FROM ${s}.canonical_edges ORDER BY id`,
    )) as CanonicalDump["edges"],
    distinctions: (await session.query(
      `SELECT a, b FROM ${s}.canonical_distinctions ORDER BY a, b`,
    )) as CanonicalDump["distinctions"],
    projections: (await session.query(
      `SELECT dest, local_id, remote_id, synced_at FROM ${s}.canonical_projections ORDER BY dest, local_id`,
    )) as CanonicalDump["projections"],
    meta: meta.filter((m) => m.key !== "rev" && m.key !== "registry_yml"),
    shares: (await session.query(
      `SELECT kind, ref, shared_at FROM ${s}.canonical_shares ORDER BY kind, ref`,
    )) as CanonicalDump["shares"],
  };
}

// ---- 반영 (덤프 → PG) — rev 가드 단일 트랜잭션: 전부 아니면 전무 (AC5) ----

export async function flushCanonicalToPg(
  session: PgCanonicalSession,
  schema: string,
  dump: CanonicalDump,
): Promise<{ rev: number }> {
  assertCanonicalSchema(schema);
  if (dump.schema !== CANONICAL_DUMP_SCHEMA) {
    throw new PgStoreError(422, [`덤프 스키마가 맞지 않는다 (기대 ${CANONICAL_DUMP_SCHEMA})`]);
  }
  const s = schema;
  const next = dump.rev + 1;
  const statements: PgStatement[] = [
    ...TABLES.map((t) => ({ sql: `DELETE FROM ${s}.canonical_${t}` })),
    ...dump.nodes.map((n) => ({
      sql: `INSERT INTO ${s}.canonical_nodes(id, name, kind, path, props) VALUES ($1,$2,$3,$4,$5)`,
      params: [n.id, n.name, n.kind, n.path, n.props],
    })),
    ...dump.aliases.map((a) => ({
      sql: `INSERT INTO ${s}.canonical_aliases(node_id, alias) VALUES ($1,$2)`,
      params: [a.node_id, a.alias],
    })),
    ...dump.edges.map((e) => ({
      sql: `INSERT INTO ${s}.canonical_edges(id, s, v, o, confidence, fallback, by, src_note, src_lost, origin) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      params: [e.id, e.s, e.v, e.o, e.confidence, e.fallback, e.by, e.src_note, e.src_lost, e.origin],
    })),
    ...dump.distinctions.map((d) => ({
      sql: `INSERT INTO ${s}.canonical_distinctions(a, b) VALUES ($1,$2)`,
      params: [d.a, d.b],
    })),
    ...dump.projections.map((pr) => ({
      sql: `INSERT INTO ${s}.canonical_projections(dest, local_id, remote_id, synced_at) VALUES ($1,$2,$3,$4)`,
      params: [pr.dest, pr.local_id, pr.remote_id, pr.synced_at],
    })),
    ...dump.meta.map((m) => ({
      sql: `INSERT INTO ${s}.canonical_meta(key, value) VALUES ($1,$2)`,
      params: [m.key, m.value],
    })),
    ...(dump.shares ?? []).map((sh) => ({
      sql: `INSERT INTO ${s}.canonical_shares(kind, ref, shared_at) VALUES ($1,$2,$3)`,
      params: [sh.kind, sh.ref, sh.shared_at],
    })),
    { sql: `INSERT INTO ${s}.canonical_meta(key, value) VALUES ($1,$2)`, params: ["registry_yml", dump.registryYml] },
    { sql: `INSERT INTO ${s}.canonical_meta(key, value) VALUES ($1,$2)`, params: ["rev", String(next)] },
  ];
  // 가드 — 첫 flush(rev 0·meta 비어 있음)는 부재 허용, 그 뒤는 rev 일치가 조건이다.
  const guard: PgStatement =
    dump.rev === 0
      ? {
          sql: `SELECT 1 AS ok WHERE NOT EXISTS (SELECT 1 FROM ${s}.canonical_meta WHERE key = 'rev' AND value <> '0')`,
        }
      : { sql: `SELECT 1 AS ok FROM ${s}.canonical_meta WHERE key = 'rev' AND value = $1`, params: [String(dump.rev)] };
  await session.transact(statements, guard);
  return { rev: next };
}

// ---- 수집함 (#81) — 원격 캡처의 보류함. 사용자 PG 안이다: 허브 보관 0 그대로 ----

export interface InboxNote {
  title: string;
  md: string;
  capturedAt: string;
}

export async function pushInbox(
  session: PgCanonicalSession,
  schema: string,
  note: { title: string; md: string },
  now: string,
): Promise<{ id: string }> {
  assertCanonicalSchema(schema);
  const title = note.title.trim();
  if (title.length === 0 || note.md.trim().length === 0) {
    throw new PgStoreError(422, ["캡처의 제목·본문이 비어 있다"]);
  }
  const id = crypto.randomUUID();
  await session.transact([
    ...ddl(schema), // 멱등 — 첫 캡처가 적재(탄생)보다 먼저 올 수 있다
    {
      sql: `INSERT INTO ${schema}.canonical_inbox(id, title, md, captured_at) VALUES ($1,$2,$3,$4)`,
      params: [id, title.slice(0, 200), note.md, now],
    },
  ]);
  return { id };
}

/** 비우기 — 읽고 지우는 한 판. 돌려준 것만 지운다 (드레인 사이에 들어온 캡처는 다음 판 몫). */
export async function drainInbox(session: PgCanonicalSession, schema: string): Promise<InboxNote[]> {
  assertCanonicalSchema(schema);
  await session.transact(ddl(schema)); // 멱등 — 빈 정본의 드레인도 선다
  const rows = (await session.query(
    `SELECT id, title, md, captured_at FROM ${schema}.canonical_inbox ORDER BY captured_at, id`,
  )) as { id: string; title: string; md: string; captured_at: string }[];
  if (rows.length === 0) return [];
  await session.transact(
    rows.map((r) => ({ sql: `DELETE FROM ${schema}.canonical_inbox WHERE id = $1`, params: [r.id] })),
  );
  return rows.map((r) => ({ title: r.title, md: r.md, capturedAt: r.captured_at }));
}
