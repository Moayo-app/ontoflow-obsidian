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

export interface HubResponseLike {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

export type FetchLike = (
  url: string,
  init: { method: "POST"; headers: Record<string, string>; body: string },
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
}

// 전송은 주입이다 — 기본값 `fetch` 를 두지 않는다 (#105): 플러그인 출처의 fetch 는 CORS 를
// 받으므로 조용한 폴백이 곧 「연결은 됐는데 아무것도 안 간다」가 된다. 호출자가 requestUrl
// 전송을 명시로 꽂는다 (main.ts obsidianFetch · 테스트는 가짜).
export function hubClient(baseUrl: string, token: TokenProvider, fetchFn: FetchLike): HubClient {
  const base = baseUrl.replace(/\/+$/, "");
  const post = async <T>(path: string, body: unknown): Promise<T> => {
    if (base === "") throw new HubClientError(0, ["허브 주소가 설정되지 않았다 — 설정 탭에서 먼저"]);
    const t = await token();
    if (t === null || t.trim() === "") {
      throw new HubClientError(401, ["허브 토큰이 없다 — 설정 탭에서 허브를 연결하라"]);
    }
    const res = await fetchFn(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${t}` },
      body: JSON.stringify(body),
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
  return {
    extractIncremental: (call) => post<PipelineIncrementalResponse>("/v1/extract/incremental", call),
    extractReindex: (call) => post<PipelineReindexResponse>("/v1/extract/reindex", call),
    synthesize: (input) => post<SynthesisNote>("/v1/synthesize", { input }),
    synthesizeTo: async (dest, title, md) => {
      await post(`/v1/synthesize/${dest}`, { title, md });
    },
    canonicalLoad: () => post<CanonicalDump>("/v1/canonical/pg/load", {}),
    canonicalFlush: (dump) => post<{ rev: number }>("/v1/canonical/pg/flush", { dump }),
    canonicalDrainInbox: () => post<{ notes: InboxNote[] }>("/v1/canonical/pg/inbox/drain", {}),
  };
}
