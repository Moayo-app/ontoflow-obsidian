// Notion 단방향 투영 (F9 · API3) — 주문형 출고: 플러그인이 정본 델타와 투영 상태를 올리면
// 허브가 금고의 토큰으로 쓰고 버퍼를 버린다 (보관 0 — 스펙 AC30). 되읽기 0 (moayo-hq#271
// 결의 9 · 스펙 AC27): NotionClient 경계에는 읽기 연산 자체가 없다 — 단방향의 구조 증명.
// 상시 돌봄 외부 표면 상한 2 의 한 자리 — API 버전은 핀으로 고정하고, 버전 업은 칼 ② 비용.
//
// 고정 매핑 (이슈 비범위 — 커스터마이즈·템플릿 없음): 대상 페이지 아래 노드 DB·엣지 DB 둘.
// 노드 → 노드 DB 의 행 페이지, 엣지 → 엣지 DB 의 행 + s·o Relation 속성. DB 보장·HTTP 는
// NotionClient 어댑터 몫이고, 이 모듈은 판정(멱등·재개·보류)만 든다.
import type { Registry } from "./registry.js";
import {
  edgeLocalId,
  nodeLocalId,
  type GraphStore,
  type ProjectionFailure,
  type ProjectionOutcome,
} from "./store.js";

export class NotionError extends Error {
  constructor(readonly problems: string[]) {
    super(`Notion 투영 거부:\n- ${problems.join("\n- ")}`);
    this.name = "NotionError";
  }
}

// ---- API 버전 핀 · 레이트리밋 (이슈 「핵심 기능 범위」) ----

export const NOTION_API_VERSION = "2022-06-28";
/** 평균 3 rps 준수 — 어댑터는 호출 간격을 이 아래로 좁히지 않는다. */
export const NOTION_MIN_INTERVAL_MS = 334;

// 토큰이 닿는 유일한 자리 — 출고 판정(projectToNotion)은 토큰을 아예 받지 않는다 (AC5).
export function notionHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "Notion-Version": NOTION_API_VERSION,
    "Content-Type": "application/json",
  };
}

// 전송 오류 — HTTP 어댑터가 상태 코드와 Retry-After 를 실어 던진다 (전송 단절은 status 0).
export class NotionApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "NotionApiError";
  }
}

// 429·5xx·전송 단절은 재시도성 — 즉시 멈추고 실패를 기록, 다음 출고에서 재개한다 (AC3).
export const isRetryable = (status: number): boolean =>
  status === 429 || status >= 500 || status === 0;

// ---- 정본 델타 (플러그인 면) — 투영 상태와의 대조로 만든다 ----

// 로컬 id 어휘는 목적지 공통이라 store.ts(투영 상태의 정본 면)에 산다 — 여기서 재수출한다.
export { edgeLocalId, nodeLocalId } from "./store.js";

export interface NodePayload {
  localId: string;
  name: string;
  kind: "file" | "concept";
  aliases: string[];
}

export interface EdgePayload {
  localId: string;
  sLocalId: string;
  oLocalId: string;
  verb: string;
  superclass: string;
  confidence: number;
  fallback: boolean;
  by: "auto" | "user";
}

export interface NotionDelta {
  /** 정본 전량 — 생성/덮어쓰기는 매핑 유무로 갈린다. 덮어쓰기가 곧 단방향의 집행이다 (AC2). */
  nodes: NodePayload[];
  edges: EdgePayload[];
  /** 정본에서 사라진 매핑 — 원격 아카이브 대상. 엣지가 노드보다 먼저다. */
  removals: { localId: string; remoteId: string }[];
}

function allRows(store: GraphStore, sql: string): Record<string, unknown>[] {
  const stmt = store.db.prepare(sql);
  const out: Record<string, unknown>[] = [];
  try {
    while (stmt.step()) out.push(stmt.getAsObject());
  } finally {
    stmt.free();
  }
  return out;
}

// 정본 스냅샷을 투영 상태와 대조해 델타를 만든다. projections 테이블에는 내용 해시가 없어
// (스펙 DDL 고정) 변경 감지 대신 전량 멱등 upsert 를 보낸다 — 주문형·정본 기준 덮기라 무해하다.
export function computeNotionDelta(
  store: GraphStore,
  registry: Registry,
  mapping: Record<string, string>,
): NotionDelta {
  const superclass = new Map(registry.verbs.map((v) => [v.id, v.superclass as string]));

  const nodes = allRows(store, "SELECT id, name, kind FROM nodes ORDER BY name").map(
    (r): NodePayload => ({
      localId: nodeLocalId(r.id as string),
      name: r.name as string,
      kind: r.kind as "file" | "concept",
      aliases: [],
    }),
  );
  const byNodeId = new Map(nodes.map((n) => [n.localId, n]));
  for (const r of allRows(store, "SELECT node_id, alias FROM aliases ORDER BY alias")) {
    byNodeId.get(nodeLocalId(r.node_id as string))?.aliases.push(r.alias as string);
  }

  const problems: string[] = [];
  const edges = allRows(
    store,
    "SELECT id, s, v, o, confidence, fallback, by FROM edges ORDER BY id",
  ).map((r): EdgePayload => {
    const verb = r.v as string;
    if (!superclass.has(verb)) problems.push(`정본의 동사가 등록부에 없습니다: ${verb}`);
    return {
      localId: edgeLocalId(r.id as string),
      sLocalId: nodeLocalId(r.s as string),
      oLocalId: nodeLocalId(r.o as string),
      verb,
      superclass: superclass.get(verb) ?? "",
      confidence: r.confidence as number,
      fallback: (r.fallback as number) === 1,
      by: r.by as "auto" | "user",
    };
  });
  if (problems.length > 0) throw new NotionError([...new Set(problems)]);

  const live = new Set([...nodes.map((n) => n.localId), ...edges.map((e) => e.localId)]);
  const removals = Object.keys(mapping)
    .filter((localId) => !live.has(localId))
    .sort() // "edge:" < "node:" — 엣지 아카이브가 노드보다 먼저 선다
    .map((localId) => ({ localId, remoteId: mapping[localId] as string }));

  return { nodes, edges, removals };
}

// ---- 허브 면 (무상태) — POST /v1/project/notion 의 판정 ----

// 쓰기 연산뿐이다 — 읽기 연산이 없는 것이 되읽기 0 의 구조 증명이다 (AC2 · 스펙 AC27).
export interface NotionClient {
  createNodePage(node: NodePayload): Promise<{ id: string }>;
  updateNodePage(remoteId: string, node: NodePayload): Promise<void>;
  createEdgeRow(edge: EdgePayload, sRemoteId: string, oRemoteId: string): Promise<{ id: string }>;
  updateEdgeRow(
    remoteId: string,
    edge: EdgePayload,
    sRemoteId: string,
    oRemoteId: string,
  ): Promise<void>;
  archive(remoteId: string): Promise<void>;
}

// 무상태 — 등록부·델타·매핑 전부 요청에 실려 온다. 토큰은 이 입력에 없다:
// 어댑터(금고 → HTTP 클라이언트 조립)가 들고, 판정은 결과값 밖에 아무것도 남기지 않는다 (AC5).
export interface NotionProjectionInput {
  registry: Registry;
  delta: NotionDelta;
  mapping: Record<string, string>;
}

export interface NotionProjectionResult {
  written: {
    createdNodes: number;
    updatedNodes: number;
    createdEdges: number;
    updatedEdges: number;
    archived: number;
  };
  /** 생성분 + 원격 소실 재생성분 — 사용자 자리 투영 상태에 박을 새 매핑 (AC1). */
  newMappings: { localId: string; remoteId: string }[];
  /** 덮어쓰기 성공분 — synced_at 갱신 대상. */
  syncedLocalIds: string[];
  /** 아카이브 성공분(이미 없던 것 포함) — 매핑 삭제 대상. */
  removedLocalIds: string[];
  /** 비재시도 실패 — 그 항목만 보류하고 계속한다. */
  held: { localId: string; reason: string }[];
  /** 재시도성 중단 — 재개 커서. null 이면 완주다. */
  failure: ProjectionFailure | null;
}

type Classified =
  | { kind: "gone" }
  | { kind: "retryable"; status: number; retryAfterMs?: number }
  | { kind: "held"; reason: string };

// NotionApiError 만 분류한다 — 그 밖의 예외는 버그라 그대로 던진다.
function classify(e: unknown): Classified {
  if (!(e instanceof NotionApiError)) throw e;
  if (e.status === 404) return { kind: "gone" };
  if (isRetryable(e.status)) {
    return e.retryAfterMs === undefined
      ? { kind: "retryable", status: e.status }
      : { kind: "retryable", status: e.status, retryAfterMs: e.retryAfterMs };
  }
  return { kind: "held", reason: `${e.status}: ${e.message}` };
}

function validateInput(input: NotionProjectionInput): void {
  const verbs = new Set(input.registry.verbs.map((v) => v.id));
  const unknown = [
    ...new Set(input.delta.edges.filter((e) => !verbs.has(e.verb)).map((e) => e.verb)),
  ];
  if (unknown.length > 0) {
    throw new NotionError(unknown.map((v) => `델타의 동사가 등록부 밖입니다: ${JSON.stringify(v)}`));
  }
}

// 출고 판정 — 노드 → 엣지 → 제거 순서의 순차 쓰기 (레이트리밋 준수: 병렬 난사 없음).
// 멱등은 원격 id 매핑 기준이다 (AC4): 매핑에 있으면 덮어쓰고, 없으면 만든다. 원격에서
// 지워진 항목(404)은 정본 기준으로 재생성한다 — 단방향의 끝 집행 (AC2).
export async function projectToNotion(
  client: NotionClient,
  input: NotionProjectionInput,
  now: () => string = () => new Date().toISOString(),
): Promise<NotionProjectionResult> {
  validateInput(input);
  const mapping = { ...input.mapping }; // 작업 사본 — 입력은 불변이다
  const result: NotionProjectionResult = {
    written: { createdNodes: 0, updatedNodes: 0, createdEdges: 0, updatedEdges: 0, archived: 0 },
    newMappings: [],
    syncedLocalIds: [],
    removedLocalIds: [],
    held: [],
    failure: null,
  };
  const stop = (localId: string, c: { status: number; retryAfterMs?: number }): void => {
    result.failure = {
      at: now(),
      localId,
      status: c.status,
      ...(c.retryAfterMs === undefined ? {} : { retryAfterMs: c.retryAfterMs }),
    };
  };
  const created = (localId: string, remoteId: string): void => {
    mapping[localId] = remoteId;
    result.newMappings.push({ localId, remoteId });
  };

  for (const node of input.delta.nodes) {
    const remoteId = mapping[node.localId];
    try {
      if (remoteId === undefined) {
        created(node.localId, (await client.createNodePage(node)).id);
        result.written.createdNodes++;
        continue;
      }
      await client.updateNodePage(remoteId, node);
      result.syncedLocalIds.push(node.localId);
      result.written.updatedNodes++;
    } catch (e) {
      const c = classify(e);
      if (c.kind === "retryable") {
        stop(node.localId, c);
        return result;
      }
      if (c.kind === "held") {
        result.held.push({ localId: node.localId, reason: c.reason });
        delete mapping[node.localId]; // 엣지가 보류 노드에 매달리지 않게
        continue;
      }
      // 원격 소실 — 정본 기준 재생성 (AC2).
      try {
        created(node.localId, (await client.createNodePage(node)).id);
        result.written.createdNodes++;
      } catch (e2) {
        const c2 = classify(e2);
        if (c2.kind === "retryable") {
          stop(node.localId, c2);
          return result;
        }
        result.held.push({
          localId: node.localId,
          reason: c2.kind === "held" ? c2.reason : "재생성 직후 재소실",
        });
        delete mapping[node.localId];
      }
    }
  }

  for (const edge of input.delta.edges) {
    const s = mapping[edge.sLocalId];
    const o = mapping[edge.oLocalId];
    if (s === undefined || o === undefined) {
      result.held.push({ localId: edge.localId, reason: "끝점 노드가 미해결이다" });
      continue;
    }
    const remoteId = mapping[edge.localId];
    try {
      if (remoteId === undefined) {
        created(edge.localId, (await client.createEdgeRow(edge, s, o)).id);
        result.written.createdEdges++;
        continue;
      }
      await client.updateEdgeRow(remoteId, edge, s, o);
      result.syncedLocalIds.push(edge.localId);
      result.written.updatedEdges++;
    } catch (e) {
      const c = classify(e);
      if (c.kind === "retryable") {
        stop(edge.localId, c);
        return result;
      }
      if (c.kind === "held") {
        result.held.push({ localId: edge.localId, reason: c.reason });
        continue;
      }
      try {
        created(edge.localId, (await client.createEdgeRow(edge, s, o)).id);
        result.written.createdEdges++;
      } catch (e2) {
        const c2 = classify(e2);
        if (c2.kind === "retryable") {
          stop(edge.localId, c2);
          return result;
        }
        result.held.push({
          localId: edge.localId,
          reason: c2.kind === "held" ? c2.reason : "재생성 직후 재소실",
        });
      }
    }
  }

  for (const removal of input.delta.removals) {
    try {
      await client.archive(removal.remoteId);
      result.removedLocalIds.push(removal.localId);
      result.written.archived++;
    } catch (e) {
      const c = classify(e);
      if (c.kind === "gone") {
        result.removedLocalIds.push(removal.localId); // 이미 없다 — 제거 멱등
        continue;
      }
      if (c.kind === "retryable") {
        stop(removal.localId, c);
        return result;
      }
      result.held.push({ localId: removal.localId, reason: c.reason });
    }
  }

  return result;
}

// 출고 결과 → 투영 상태 반영분 (store.recordProjectionResult 의 입력).
export function toProjectionOutcome(result: NotionProjectionResult): ProjectionOutcome {
  return {
    newMappings: result.newMappings,
    syncedLocalIds: result.syncedLocalIds,
    removedLocalIds: result.removedLocalIds,
    failure: result.failure,
  };
}
