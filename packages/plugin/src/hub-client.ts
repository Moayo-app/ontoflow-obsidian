// 허브 호출 (API1 증분 · API2 재색인) — 플러그인 쪽 끝. 허브 토큰은 호출 헤더로만 흐른다:
// 이 모듈은 로그를 쓰지 않고, 오류에 토큰도 응답 원문도 되비치지 않는다 (AC5).
import type {
  CanonicalDump,
  InboxNote,
  ContextEdge,
  SynthesisInput,
  SynthesisNote,
  IncrementalChange,
  NormalizationDictionary,
  PipelineIncrementalResponse,
  PipelineReindexResponse,
  Registry,
  ReindexNote,
} from "./core.js";

export class HubClientError extends Error {
  constructor(
    readonly status: number,
    readonly problems: string[],
  ) {
    super(`허브 호출 실패 (HTTP ${status}):\n- ${problems.join("\n- ")}`);
    this.name = "HubClientError";
  }
}

/** 설정 저장소의 토큰을 호출 시점에 읽는다 — 클라이언트는 값을 붙들어 두지 않는다 (AC5). */
export type TokenProvider = () => Promise<string | null>;

/**
 * 워크스페이스 문맥 (ISSUE-365) — 설정의 workspaceId 를 호출 시점에 읽는다. null = 개인.
 * 서 있으면 크레딧 소비처 호출(추출·합성)에 orgId 로 실려 과금이 워크스페이스 풀로 간다 —
 * 개인 정본(canonical*)에는 싣지 않는다: 그 축은 workspace* 메서드가 명시로 분리한다.
 */
export type WorkspaceProvider = () => string | null;

export interface HubResponseLike {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

export type FetchLike = (
  url: string,
  init: { method: "POST" | "GET"; headers: Record<string, string>; body?: string },
) => Promise<HubResponseLike>;

export interface IncrementalCall {
  registry: Registry;
  changes: IncrementalChange[];
  context: ContextEdge[];
  /** 정규화 별칭 사전 — 허브는 무상태라 정본 면에서 실어 보낸다 (#47). */
  dictionary?: NormalizationDictionary;
}

export interface ReindexCall {
  registry: Registry;
  notes: ReindexNote[];
  dictionary?: NormalizationDictionary;
}

/** 추출기 계약 (#88) — 허브(API1·API2)든 BYO 로컬이든, 수집 배선이 보는 꼴은 이 둘뿐이다. */
export interface Extractor {
  extractIncremental(call: IncrementalCall): Promise<PipelineIncrementalResponse>;
  extractReindex(call: ReindexCall): Promise<PipelineReindexResponse>;
}

/** 내 워크스페이스 한 줄 (GET /v1/orgs 꼴의 부분) — 설정 탭 전환기의 재료다. */
export interface WorkspaceSummary {
  orgId: string;
  name: string;
  role: string;
}

/** 동기화 판정 응답 (ISSUE-372) — Notion·PostgreSQL 공통 꼴: 매핑 반영 재료가 전부다. */
export interface ProjectionWire {
  written: Record<string, number>;
  newMappings: { localId: string; remoteId: string }[];
  syncedLocalIds: string[];
  removedLocalIds: string[];
  held?: { localId: string; reason: string }[];
  failure: unknown | null;
}

export interface HubClient extends Extractor {
  /** 합성 판정 (#59) — 소스 부분 그래프 → 정리 노트 (파일 자리 쓰기는 호출자 몫). */
  synthesize(input: SynthesisInput): Promise<SynthesisNote>;
  /** 합성 API 출고 (#56·#57 쓰기 경로) — 마커는 허브가 목적지 메타로 입힌다. */
  synthesizeTo(dest: "onenote" | "evernote", title: string, md: string): Promise<void>;
  /** PG 정본 (#63) — 적재·반영: 자격증명은 금고의 postgres 꼴, 내용은 사용자 PG 에만 산다. */
  canonicalLoad(): Promise<CanonicalDump>;
  canonicalFlush(dump: CanonicalDump): Promise<{ rev: number }>;
  /** PG 수집함 비우기 (#81) — 원격 MCP 캡처분을 vault 수집함으로 내리는 드레인. */
  canonicalDrainInbox(): Promise<{ notes: InboxNote[] }>;
  /**
   * 워크스페이스 투영 (ISSUE-365) — 조직 PG 의 내 멤버 스키마에 적재·반영. 개인 canonical* 와
   * 정본 축이 다르다: 정본 지위는 무변이고(가시성 ≠ 소유 — #53·#214), 이 사본은 합집합·전문가
   * 찾기가 공유 표시만 읽는 재료다. 워크스페이스 미선택이면 호출 전에 명시 오류로 선다.
   */
  workspaceLoad(): Promise<CanonicalDump>;
  workspaceFlush(dump: CanonicalDump): Promise<{ rev: number }>;
  /** 내 워크스페이스 목록 (#295 꼴 승계) — 설정 탭 전환기의 재료. */
  listWorkspaces(): Promise<WorkspaceSummary[]>;
  /**
   * 연결된 API 소스 (ISSUE-364) — 허브 금고의 수집 자격증명 존재 비트뿐이다. 워크스페이스
   * 문맥이면 조직 금고(관리자가 연결한 소스)를 본다 — orgId 는 billed 스프레드가 싣는다.
   */
  /** 인증 핑 (ISSUE-372) — 주소·토큰이 실제로 서는지 한 번의 GET 으로 확인한다(부수효과 0). */
  ping(): Promise<void>;
  /** 동기화 집행 (ISSUE-372 — 출고 표면) — 델타·매핑을 싣고 허브 판정 결과를 받는다. 크레딧 비소비(내보내기). */
  projectTo(dest: "notion" | "postgres", input: unknown): Promise<ProjectionWire>;
  ingestSources(): Promise<string[]>;
  /** API 소스 한 종의 pull — known(증분 선별 재료)을 싣고 pull 결과(JSON)를 받는다. */
  ingestPull(kind: string, known: unknown): Promise<unknown>;
}

// 전송은 주입이다 — 기본값 `fetch` 를 두지 않는다 (#105): 플러그인 출처의 fetch 는 CORS 를
// 받으므로 조용한 폴백이 곧 「연결은 됐는데 아무것도 안 간다」가 된다. 호출자가 requestUrl
// 전송을 명시로 꽂는다 (main.ts obsidianFetch · 테스트는 가짜).
export function hubClient(
  baseUrl: string,
  token: TokenProvider,
  fetchFn: FetchLike,
  workspace: WorkspaceProvider = () => null,
): HubClient {
  const base = baseUrl.replace(/\/+$/, "");
  const call = async <T>(method: "POST" | "GET", path: string, body?: unknown): Promise<T> => {
    if (base === "") throw new HubClientError(0, ["허브 주소가 설정되지 않았다 — 설정 탭에서 먼저"]);
    const t = await token();
    if (t === null || t.trim() === "") {
      throw new HubClientError(401, ["허브 토큰이 없다 — 설정 탭에서 허브를 연결하라"]);
    }
    const res = await fetchFn(`${base}${path}`, {
      method,
      headers: { "content-type": "application/json", authorization: `Bearer ${t}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    if (!res.ok) {
      // 오류는 상태와 problems 만 나른다 — 토큰·응답 원문의 되비침 0 (AC5).
      let problems = [`허브가 ${res.status} 로 거절했다`];
      try {
        const doc = JSON.parse(text) as { problems?: unknown };
        if (Array.isArray(doc.problems) && doc.problems.every((p): p is string => typeof p === "string")) {
          problems = doc.problems;
        }
      } catch {
        // 본문이 JSON 이 아니면 상태만 — 원문은 싣지 않는다
      }
      throw new HubClientError(res.status, problems);
    }
    return JSON.parse(text) as T;
  };
  const post = <T>(path: string, body: unknown): Promise<T> => call<T>("POST", path, body);
  // 과금 문맥 (ISSUE-365) — 크레딧 소비처(추출·합성·출고)에만 orgId 를 싣는다: 워크스페이스가
  // 서 있으면 풀 지갑, 아니면 개인. 개인 정본 canonical* 는 이 스프레드를 지나지 않는다.
  const billed = (body: Record<string, unknown>): Record<string, unknown> => {
    const orgId = workspace();
    return orgId === null ? body : { ...body, orgId };
  };
  const requireWorkspace = (): string => {
    const orgId = workspace();
    if (orgId === null) {
      throw new HubClientError(0, ["워크스페이스가 선택되지 않았다 — 설정 탭에서 먼저 고르라"]);
    }
    return orgId;
  };
  return {
    extractIncremental: (c) => post<PipelineIncrementalResponse>("/v1/extract/incremental", billed({ ...c })),
    extractReindex: (c) => post<PipelineReindexResponse>("/v1/extract/reindex", billed({ ...c })),
    synthesize: (input) => post<SynthesisNote>("/v1/synthesize", billed({ input })),
    synthesizeTo: async (dest, title, md) => {
      await post(`/v1/synthesize/${dest}`, billed({ title, md }));
    },
    canonicalLoad: () => post<CanonicalDump>("/v1/canonical/pg/load", {}),
    canonicalFlush: (dump) => post<{ rev: number }>("/v1/canonical/pg/flush", { dump }),
    canonicalDrainInbox: () => post<{ notes: InboxNote[] }>("/v1/canonical/pg/inbox/drain", {}),
    workspaceLoad: () => post<CanonicalDump>("/v1/canonical/pg/load", { orgId: requireWorkspace() }),
    workspaceFlush: (dump) => post<{ rev: number }>("/v1/canonical/pg/flush", { orgId: requireWorkspace(), dump }),
    ping: async () => {
      await call("GET", "/v1/account");
    },
    projectTo: (dest, input) => post<ProjectionWire>(`/v1/project/${dest}`, input as Record<string, unknown>),
    ingestSources: async () => {
      const doc = await post<{ kinds?: unknown }>("/v1/ingest/sources", billed({}));
      return Array.isArray(doc.kinds) ? doc.kinds.filter((k): k is string => typeof k === "string") : [];
    },
    ingestPull: (kind, known) => post(`/v1/ingest/${kind}`, billed({ known })),
    listWorkspaces: async () => {
      const doc = await call<{ orgs?: { orgId?: unknown; name?: unknown; role?: unknown }[] }>("GET", "/v1/orgs");
      return (doc.orgs ?? []).map((o) => ({
        orgId: String(o.orgId ?? ""),
        name: String(o.name ?? ""),
        role: String(o.role ?? "member"),
      }));
    },
  };
}
