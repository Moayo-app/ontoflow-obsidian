// 플러그인 설정 — 허브 토큰이 사는 유일한 자리다 (AC5): 옵시디언 플러그인 설정 저장소(data.json)
// 밖으로는 호출 헤더로만 흐르고, 로그·노트 본문·오류 문구 어디에도 싣지 않는다.
// 수집 소스 목록(#55)도 여기 산다 — 연결 사실만이 수집의 근거라(AC4), 등록부가 곧 분모다.
// BYO 추출(#88)의 자격증명도 같은 규율로 여기 산다 — 허브 금고에 두지 않는다: 허브가 그
// 엔드포인트를 결코 호출하지 않으므로, 기기를 떠나지 않는 것이 이 경로의 금고 규율이다.
import { parseIngestSources, type IngestSource } from "./core.js";

/** 정본 자리 (#63) — sqlite(기본, 그래프 홈 파일) 또는 pg(사용자 소유 PostgreSQL, 금고 경유). */
export type CanonicalMode = "sqlite" | "pg";

export interface PluginSettings {
  hubBaseUrl: string;
  hubToken: string | null;
  sources: IngestSource[];
  canonical: CanonicalMode;
  /** BYO 추출 엔드포인트 (#88) — OpenAI 호환 주소. 비우면 모아요 서빙(기본). */
  byoUrl: string;
  /** BYO 모델명 — 품질 비보증이라 선택은 사용자 몫. 주소와 모델이 둘 다 서야 BYO 가 선다. */
  byoModel: string;
  byoApiKey: string | null;
}

export const DEFAULT_SETTINGS: PluginSettings = {
  hubBaseUrl: "",
  hubToken: null,
  sources: [],
  canonical: "sqlite",
  byoUrl: "",
  byoModel: "",
  byoApiKey: null,
};

export function parseSettings(raw: unknown): PluginSettings {
  const doc = (raw ?? {}) as Partial<PluginSettings>;
  return {
    hubBaseUrl: typeof doc.hubBaseUrl === "string" ? doc.hubBaseUrl : DEFAULT_SETTINGS.hubBaseUrl,
    hubToken: typeof doc.hubToken === "string" && doc.hubToken.length > 0 ? doc.hubToken : null,
    sources: parseIngestSources(doc.sources),
    canonical: doc.canonical === "pg" ? "pg" : "sqlite",
    byoUrl: typeof doc.byoUrl === "string" ? doc.byoUrl.trim() : DEFAULT_SETTINGS.byoUrl,
    byoModel: typeof doc.byoModel === "string" ? doc.byoModel.trim() : DEFAULT_SETTINGS.byoModel,
    byoApiKey: typeof doc.byoApiKey === "string" && doc.byoApiKey.length > 0 ? doc.byoApiKey : null,
  };
}

/** BYO 추출 자격 꼴 (#88) — extractorFor 의 입력. */
export interface ByoEndpoint {
  url: string;
  model: string;
  apiKey: string | null;
}

// 주소·모델이 둘 다 서야 BYO 다 — 반쪽 설정은 null: 기본 경로(모아요 서빙)가 그대로 선다
// (닫힌 기본 — 반쯤 연결이 없다).
export function byoEndpointOf(settings: PluginSettings): ByoEndpoint | null {
  if (settings.byoUrl.length === 0 || settings.byoModel.length === 0) return null;
  return { url: settings.byoUrl, model: settings.byoModel, apiKey: settings.byoApiKey };
}
