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
    while (stmt.step()) out.push(stmt.getAsObject());
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

/** 전량 치환문 — flush(rev+1·가드)와 이관 복원(rev 보존 — ISSUE-444)이 같은 몸을 쓴다. */
function canonicalReplaceStatements(schema: string, dump: CanonicalDump, revValue: number): PgStatement[] {
  const s = schema;
  const next = revValue;
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
  return statements;
}

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
  const statements = canonicalReplaceStatements(schema, dump, next);
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

/**
 * 이관 복원 (ISSUE-444) — flush 와 달리 rev 를 **그대로** 옮기고 가드가 없다: 사본이 원본과
 * 같은 얼굴이어야 재적재 대조 검증(덤프는 결정적 — 같은 상태는 같은 JSON)이 성립하고, 대상은
 * 막 태어난 자리거나 재시도의 덮어쓰기다. 일반 쓰기 경로가 아니다 — 새 호출처를 만들지 않는다.
 */
export async function restoreCanonicalToPg(
  session: PgCanonicalSession,
  schema: string,
  dump: CanonicalDump,
): Promise<void> {
  assertCanonicalSchema(schema);
  if (dump.schema !== CANONICAL_DUMP_SCHEMA) {
    throw new PgStoreError(422, [`덤프 스키마가 맞지 않는다 (기대 ${CANONICAL_DUMP_SCHEMA})`]);
  }
  await session.transact([...ddl(schema), ...canonicalReplaceStatements(schema, dump, dump.rev)]);
}

// ---- 저장 용량 측정 (ISSUE-446) — **제공 자리 자격증명 경로에서만** 부른다: 자기 PG 는
// 이용자 인프라라 재지도 않고 상한도 없다. 읽기뿐 — 쓰기·복사 연산이 아니다. ----

const RELATION_SIZE_SQL = `SELECT COALESCE(SUM(pg_total_relation_size(c.oid)), 0)::text AS bytes
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind = 'r' AND `;

function bytesOf(rows: Record<string, unknown>[]): number {
  const n = Number(rows[0]?.bytes ?? 0); // bigint 은 드라이버가 문자열로 돌려준다 — 그래서 ::text
  if (!Number.isFinite(n) || n < 0) throw new PgStoreError(500, [`저장 용량 측정값이 수가 아니다: ${String(rows[0]?.bytes)}`]);
  return n;
}

/** 한 스키마의 저장 용량(인덱스·TOAST 포함) — 개인 제공 자리(공유 DB 안 계정 스키마)의 축. */
export async function schemaStorageBytes(session: PgCanonicalSession, schema: string): Promise<number> {
  assertCanonicalSchema(schema);
  return bytesOf(await session.query(`${RELATION_SIZE_SQL}n.nspname = $1`, [schema]));
}

/**
 * DB 안 ontoflow 스키마 전부의 저장 용량 — 워크스페이스 제공 DB(#444: 조직별 데이터베이스라
 * 그 안의 전부가 그 조직 몫 — 멤버 스키마 + `ontoflow_org`)의 축.
 */
export async function canonicalStorageBytes(session: PgCanonicalSession): Promise<number> {
  return bytesOf(await session.query(`${RELATION_SIZE_SQL}n.nspname LIKE 'ontoflow%'`));
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

/** id 동반 수신함 노트 — 2단 드레인(#439 ③)에서 ack 가 짚는 손잡이다. */
export interface PeekedInboxNote extends InboxNote {
  id: string;
}

/**
 * 받기 (#439 ③ — 2단 드레인의 앞절반): 지우지 않고 돌려준다. 삭제는 호출자가 vault 파일로
 * 확정한 id 를 ackInbox 로 들고 와야 선다 — 응답 유실·파일 쓰기 실패 시 캡처가 서버에 남는
 * 것이 #81 「소실 0」 의 실물이다(재받기 중복은 허용 — at-least-once).
 */
export async function peekInbox(session: PgCanonicalSession, schema: string): Promise<PeekedInboxNote[]> {
  assertCanonicalSchema(schema);
  await session.transact(ddl(schema)); // 멱등 — 빈 정본의 받기도 선다
  const rows = (await session.query(
    `SELECT id, title, md, captured_at FROM ${schema}.canonical_inbox ORDER BY captured_at, id`,
  )) as { id: string; title: string; md: string; captured_at: string }[];
  return rows.map((r) => ({ id: r.id, title: r.title, md: r.md, capturedAt: r.captured_at }));
}

/** 삭제 확인 (#439 ③ — 2단 드레인의 뒷절반): 확정된 id 만 지운다. 모르는 id 는 무해(멱등). */
export async function ackInbox(
  session: PgCanonicalSession,
  schema: string,
  ids: readonly string[],
): Promise<void> {
  assertCanonicalSchema(schema);
  if (ids.length === 0) return;
  await session.transact(
    ids.map((id) => ({ sql: `DELETE FROM ${schema}.canonical_inbox WHERE id = $1`, params: [id] })),
  );
}

/**
 * 이관 복원 짝 (ISSUE-444) — pushInbox 와 달리 id·captured_at 을 **보존**한다: 재시도가
 * 중복 행을 만들지 않고(id 충돌 무해), 드레인 순서(captured_at)가 이관을 건너 그대로 선다.
 */
export async function restoreInbox(
  session: PgCanonicalSession,
  schema: string,
  notes: readonly PeekedInboxNote[],
): Promise<void> {
  assertCanonicalSchema(schema);
  await session.transact([
    ...ddl(schema), // 멱등 — 캡처 0 인 멤버의 이관도 선다
    ...notes.map((n) => ({
      sql: `INSERT INTO ${schema}.canonical_inbox(id, title, md, captured_at) VALUES ($1,$2,$3,$4)
        ON CONFLICT(id) DO NOTHING`,
      params: [n.id, n.title, n.md, n.capturedAt] as unknown[],
    })),
  ]);
}

/**
 * ⚠️ 한 판 드레인 — SELECT 직후 DELETE 라 응답 유실 시 캡처가 소실되는 창이 있다 (#439 ③).
 * 새 경로는 peekInbox→ackInbox 2단이고, 이 함수는 배포된 구버전 플러그인의 `/inbox/drain`
 * 호환으로만 남는다 — 새 호출처를 만들지 않는다.
 */
export async function drainInbox(session: PgCanonicalSession, schema: string): Promise<InboxNote[]> {
  const rows = await peekInbox(session, schema);
  if (rows.length === 0) return [];
  await ackInbox(
    session,
    schema,
    rows.map((r) => r.id),
  );
  return rows.map((r) => ({ title: r.title, md: r.md, capturedAt: r.capturedAt }));
}
