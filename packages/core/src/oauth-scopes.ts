// OAuth 허용 스코프 — 잎 모듈 (ISSUE-326 미러 폐쇄 판정의 집행, 2026-11-14)
//
// ⭐ **왜 잎인가**: 수집 어댑터(gdrive·dropbox·gitlab·github·atlassian)가 이 상수만 쓰는데
//    vault.ts 에 살면 **금고 전체가 플러그인 번들 전이 폐쇄에 끌려 들어간다** — 공개 미러에
//    자격증명 금고 소스가 실릴 뻔한 자리다(p0 세션 발견). passkey 레코드 잎 이사(#326)와
//    같은 결: 타입·상수는 잎으로, 검증·보관 로직은 서버 전용 모듈에 남는다.
// ⚠️ 여기는 **상수뿐**이다 — 검증(declaredScopeCheck·validateScope)은 vault.ts 몫 그대로.

/** Drive 수집의 허용 스코프 — restricted scope 하나뿐 (CASA 심사 대상 그 자체). */
export const GDRIVE_ALLOWED_SCOPES = ["https://www.googleapis.com/auth/drive.readonly"] as const;
/** Dropbox 수집의 허용 스코프 — 읽기 둘뿐. */
export const DROPBOX_ALLOWED_SCOPES = ["files.metadata.read", "files.content.read"] as const;
/** GitLab 수집(ISSUE-312)의 허용 스코프 — read_api 하나: 쓰기 급(api)은 요청 밖이라 즉시 거부다. */
export const GITLAB_ALLOWED_SCOPES = ["read_api"] as const;

/** GitHub 수집(ISSUE-313)의 허용 스코프 — 읽기 둘: classic `repo` 급은 쓰기 포함이라 즉시 거부다. */
export const GITHUB_ALLOWED_SCOPES = ["issues:read", "metadata:read"] as const;

/** Atlassian 수집(ISSUE-314)의 허용 스코프 — 읽기 넷 + offline_access(refresh 재료) 뿐이다.
 * read:me 는 `/me`(연결 사용자 account id — personal 공간 1비트 대조의 재료) 가 요구한다:
 * 앱 등록 실집행(2026-11-11)에서 핀 목록의 누락으로 드러나 +1 됐다. */
export const ATLASSIAN_ALLOWED_SCOPES = [
  "read:jira-work",
  "read:page:confluence",
  "read:space:confluence",
  "read:me",
  "offline_access",
] as const;
/** Evernote MCP(#98) — 수집은 read 하나, 합성 출고는 create 하나: 분리가 스코프다. */
export const EVERNOTE_INGEST_ALLOWED_SCOPES = ["read"] as const;
export const EVERNOTE_SYNTHESIS_ALLOWED_SCOPES = ["create"] as const;
