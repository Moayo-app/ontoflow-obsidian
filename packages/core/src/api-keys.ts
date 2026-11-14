// 허브 API 키 (ISSUE-363) — 장수 기계 자격: 플러그인과 원격 MCP 가 수명 ~1시간의 사람 세션
// (Firebase ID 토큰) 없이 허브를 지나는 유일한 길이다. 규율은 SCIM 토큰과 같다 — 평문은 발급
// 응답 한 번뿐, 보관은 해시만, 로그·오류 비노출(금고와 같은 결).
//
// ⭐ **키는 처리면의 자격이지 계정 자격이 아니다** — 유출된 키가 새 키·패스키 발급(자격 증식),
// 금고 쓰기, 워크스페이스 관리, 과금으로 오르는 길을 끊는다: 허용 경로는 닫힌 기본의
// 명시 목록(`apiKeyAllowedPath`)이고, 목록 밖은 전부 사람 세션만 지난다.

/** 키 평문 접두 — JWT(점 3부)와 한 글자에서 갈려 인증 미들웨어가 모양으로 분기한다. */
export const API_KEY_PREFIX = "ofk_";

/** 계정당 키 상한 — 기계 수만큼이면 된다: 무한 발급은 분실 키 관리를 불가능하게 만든다. */
export const API_KEY_LIMIT = 10;

/** 마지막 사용 도장의 해상도 — 요청마다 쓰면 파일 DB 에 쓰기 증폭이라 시간 단위로만 찍는다. */
export const API_KEY_TOUCH_INTERVAL_MS = 60 * 60 * 1000;

export interface HubApiKey {
  id: string;
  /** 사용자가 붙인 이름 — 어느 기계의 키인지 가리는 라벨일 뿐, 판정에 쓰지 않는다. */
  label: string;
  /** SHA-256 hex — 평문은 서버 어디에도 살지 않는다. */
  hash: string;
  createdAt: string;
  /** 마지막 사용(시간 단위 도장) — 「안 쓰는 키를 회수하라」의 재료다. null = 사용 전. */
  lastUsedAt: string | null;
}

/** 콘솔이 보는 꼴 — 해시는 내부값이라 응답에 싣지 않는다 (패스키 뷰와 같은 규율). */
export interface HubApiKeyView {
  id: string;
  label: string;
  createdAt: string;
  lastUsedAt: string | null;
}

export function isApiKeyShaped(bearer: string): boolean {
  return bearer.startsWith(API_KEY_PREFIX);
}

/** 평문 생성 — 엔트로피는 UUID 둘(256비트 꼴·hex 64자리), 해시는 호출자(허브)가 뜬다. */
export function mintApiKeyPlain(): string {
  return `${API_KEY_PREFIX}${crypto.randomUUID().replace(/-/g, "")}${crypto.randomUUID().replace(/-/g, "")}`;
}

export function apiKeyView(key: HubApiKey): HubApiKeyView {
  return { id: key.id, label: key.label, createdAt: key.createdAt, lastUsedAt: key.lastUsedAt };
}

/**
 * 처리면 허용 목록 (닫힌 기본) — API 키가 지나는 경로의 전부다. 새 라우트는 여기 더하기
 * 전까지 키에 닫혀 있다: 잊어서 열리는 쪽이 아니라 잊어서 닫혀 있는 쪽으로 틀린다.
 *   · 추출·합성·정본·수집·투영·그래프(주간 리포트)·원격 MCP — 기계의 일
 *   · GET /v1/account — 플러그인 연결 확인(읽기뿐)
 *   · GET /v1/orgs — 워크스페이스 전환기 재료(이름·역할뿐 — 관리 정보 없음)
 * 계정·워크스페이스 관리(/v1/orgs/:id·webauthn·apikeys·consent·탈퇴)와 금고(/v1/credentials)·
 * 과금(/v1/billing)은 목록 밖 = 사람 세션만.
 */
export function apiKeyAllowedPath(method: string, path: string): boolean {
  if (method === "GET") {
    return path === "/v1/account" || path === "/v1/orgs" || path.startsWith("/v1/ingest/");
  }
  if (method !== "POST") return false;
  if (path === "/v1/mcp" || path.startsWith("/v1/mcp/")) return true;
  return (
    path.startsWith("/v1/extract/") ||
    path === "/v1/synthesize" ||
    path.startsWith("/v1/synthesize/") ||
    path.startsWith("/v1/canonical/pg/") ||
    path.startsWith("/v1/ingest/") ||
    path.startsWith("/v1/project/") ||
    path.startsWith("/v1/graph/")
  );
}

/** 회수 — 없는 키면 null: 호출자가 404 로 세운다. */
export function revokeApiKey<T extends { apiKeys?: readonly HubApiKey[] }>(account: T, keyId: string): T | null {
  const keys = account.apiKeys ?? [];
  if (!keys.some((k) => k.id === keyId)) return null;
  return { ...account, apiKeys: keys.filter((k) => k.id !== keyId) };
}

/** 사용 도장 — 시간 단위 해상도: 간격 안이면 null(쓰기 생략)이다. */
export function touchApiKey<T extends { apiKeys?: readonly HubApiKey[] }>(
  account: T,
  keyId: string,
  now: string,
): T | null {
  const keys = account.apiKeys ?? [];
  const key = keys.find((k) => k.id === keyId);
  if (key === undefined) return null;
  if (key.lastUsedAt !== null && Date.parse(now) - Date.parse(key.lastUsedAt) < API_KEY_TOUCH_INTERVAL_MS) {
    return null;
  }
  return { ...account, apiKeys: keys.map((k) => (k.id === keyId ? { ...k, lastUsedAt: now } : k)) };
}
