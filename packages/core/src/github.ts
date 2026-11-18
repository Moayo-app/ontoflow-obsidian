// GitHub 수집 어댑터 경계 (ISSUE-313 — moayo-hq#279 B안 편입 ②) — #312 GitLab 과 같은 꼴:
// 읽기 연산뿐인 경계(쓰기 연산 자체가 없다), HTTP 는 허브 어댑터(github-http.ts), 자격증명·
// 스코프 규율은 #60 금고가 진다. 닻은 저장소 전체 이름(owner/repo) 하나다 — 계정·조직 전역은
// 최소 스코프 초과다. 이슈만 들인다 — 토론(Discussions)은 별도 권한 + GraphQL 전용이라 핀된
// 최소 스코프(Issues:read+Metadata:read) 밖이고(#218 큐 명칭도 「GitHub Issues」), PR·코드는
// 비범위라 어댑터가 거른다.
//
// 증분 (AC1): 이슈는 `updated_at` 커서 하나다 — GitLab 의 위키 같은 무시각 결이 없어 더 싸다.
// GitHub `since` 는 포함 경계라 커서 자신이 되돌아온다 — 델타 판정은 코어가 `>` 로 거른다.
//
// 1비트 (AC2 — #215 판정): `visibility` 는 **문자열**(public|private|internal)로 보존만 한다 —
// 불린은 private/internal 을 합쳐서 금지다. private→공유 매핑은 기각됐다(1인 private 리포의
// 사적 노트를 잘못 존속시킨다) — 공유는 구성원 직접 표시만(#218 최종 모델)이고, 이 모듈 산출
// 어디에도 공유 기록 꼴이 없는 것이 구조 증명이다.
//
// 소유자 종속 (AC3 — #218 ⚠️): 조직 연결 토큰은 연결한 사람을 탄다 — 그가 떠나면 토큰이 죽는다.
// 매 수집의 첫 문이 저장소 메타데이터 호출이라, 자격 상실은 **항상 명시 오류**로 선다 — 빈
// 성공으로 위장될 자리가 구조적으로 없다 (조용한 빈 수집 금지).
import type { CollectState, VaultFileStat } from "./collect.js";
import { sourceEntryPath, sourceIssueMd, sourceKnownStats, type SourceReader } from "./sources.js";
import { GITHUB_ALLOWED_SCOPES } from "./oauth-scopes.js"; // 잎 — 금고 본체를 번들로 끌고 가지 않는다

export class GitHubError extends Error {
  constructor(readonly problems: string[]) {
    super(`GitHub 수집 거부:\n- ${problems.join("\n- ")}`);
    this.name = "GitHubError";
  }
}

/** 자격 상실의 명시면 (AC3) — 서버 라우트가 이 꼴만 재연결 안내 상태코드로 번역한다. */
export class GitHubAuthError extends GitHubError {
  constructor(problems: string[]) {
    super(problems);
    this.name = "GitHubAuthError";
  }
}

// ---- 스코프 핀 · 레이트리밋 · 후퇴 (어댑터 집행 — #62 와 같은 규율) ----

/** 요청 스코프의 전부 — 읽기 둘: 쓰기 급(repo·issues:write)은 요청 밖이라 부여 즉시 422 다 (AC4). */
export const GITHUB_INGEST_SCOPES = GITHUB_ALLOWED_SCOPES;

export const GITHUB_MIN_INTERVAL_MS = 200;
export const GITHUB_BACKOFF_BASE_MS = 1000;
export const GITHUB_BACKOFF_MAX_RETRIES = 3;

export class GitHubApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "GitHubApiError";
  }
}

/**
 * 후퇴 대상 판정 — 429, 그리고 Retry-After 가 실린 403(GitHub 2차 리밋의 꼴)뿐이다.
 * Retry-After 없는 403 은 권한 문제라 후퇴가 아니라 즉시 실패다 (재시도 폭주 입구 차단).
 */
export function isGitHubBackoffTarget(e: unknown): boolean {
  if (!(e instanceof GitHubApiError)) return false;
  return e.status === 429 || (e.status === 403 && e.retryAfterMs !== undefined);
}

// ---- 클라이언트 경계 — 읽기 연산 둘뿐이다 ----

export interface GitHubRepoInfo {
  /** public | private | internal — 문자열 그대로 (#215: 불린 금지). */
  visibility: string;
}

export interface GitHubIssueEntry {
  number: number;
  title: string;
  /** RFC3339 updated_at — 커서의 재료다. */
  updatedAt: string;
  /** 목록 응답에 본문이 동승한다 — 항목별 본문 호출 0 이 이 API 의 값이다. */
  bodyMd: string | null;
  /** 작성자·담당자 로그인 (ISSUE-529) — 목록 응답 동승분: 추가 호출 0. 구 클라이언트는 부재. */
  author?: string | null;
  assignees?: string[];
}

/** 이슈 코멘트 한 건 (ISSUE-529) — 결의·판정이 코멘트에 사는 운영 꼴의 수집 재료. */
export interface GitHubIssueComment {
  author: string | null;
  /** RFC3339 created_at — 코멘트 절의 시각 표기. */
  createdAt: string;
  bodyMd: string;
}

export interface GitHubIngestClient {
  /** 저장소 메타데이터 — 가시성의 자리이자 매 수집의 자격 검증 문이다 (AC3 구조면). */
  getRepo(repoFullName: string): Promise<GitHubRepoInfo>;
  /** since 가 null 이면 전량 — PR 행 제외·페이지 소비는 어댑터 몫. since 는 포함 경계일 수 있다. */
  listIssues(repoFullName: string, since: string | null): Promise<GitHubIssueEntry[]>;
  /** 이슈 코멘트 (ISSUE-529) — **변경 이슈에만** 불린다(코멘트 활동도 updated_at 을 올리므로
   * 기존 커서가 변경을 공짜로 잡는다). 선택 구현 — 없으면 코멘트 절 없이 간다(구 가짜·구 조립). */
  listComments?(repoFullName: string, issueNumber: number): Promise<GitHubIssueComment[]>;
}

const issueId = (number: number): string => `i-${number}`;

// ---- 이슈 → 노트 md 합성 (ISSUE-529) ----
// 메타데이터는 **위키링크 줄**로 선다: 수집의 위키링크 승격(설계 결정 ⓓ — related-to·fallback·
// origin wikilink·엔진 0)이 그대로 사람 엣지를 만든다 — 새 와이어·동사·스키마 0. 더 정밀한
// 동사(작성했다/맡고 있다)는 커스텀 동사 의식(AI 제안 + 사용자 확정)의 몫으로 남긴다.
// 코멘트 본문은 노트에 실려 추출 재료가 된다 — 「결의·판정이 코멘트에 산다」(모아요 자신의
// 운영 꼴)가 본문만 먹던 갭의 수리다.

/** 합성 본체는 sources.ts 공용 (ISSUE-529 벤더 확장) — GitLab·Jira 와 한 꼴이다. */
export function issueNoteMd(issue: GitHubIssueEntry, comments: readonly GitHubIssueComment[]): string {
  return sourceIssueMd({ author: issue.author, assignees: issue.assignees, body: issue.bodyMd }, comments);
}

// ---- 커서 증분 (AC1) ----

export interface GitHubPulledItem {
  id: string;
  title: string;
  mtime: number;
  /** 변경분만 md 가 실린다 — 무변 항목은 본문을 다시 나르지 않는다. */
  md: string | null;
  /** 메타데이터 보존 (AC2) — 공유 비트가 아니다: 공유는 구성원 직접 표시만이 만든다. */
  visibility: string;
}

export interface GitHubPull {
  /** 다음 known.cursor — 이번 목록의 최대 updated_at (이슈 0 이면 이전 값 유지). */
  cursor: string | null;
  /** true 면 커서 이후 델타 0 — 전량 목록 없이 끝났다 (AC1 의 싼 문). */
  unchanged: boolean;
  items: GitHubPulledItem[];
}

export interface GitHubKnown {
  cursor: string | null;
  files: Record<string, number>;
}

/**
 * 허브 면의 증분 판정 — ⓪ 저장소 호출이 첫 문이다: 가시성을 얻고, 자격 상실(401 · Retry-After
 * 없는 403 · 404)을 **명시 오류**로 세운다 — 소유자 퇴장이 빈 수집으로 위장될 길이 없다 (AC3).
 * ① 커서가 있으면 since 델타로 무변을 싸게 가린다 (포함 경계 보정은 여기 `>` 가 진다).
 * ② 변경이 있거나 첫 수집이면 전량 재목록 — 부재 = 삭제의 재대조(#55) 한 꼴로 통일한다
 * (Dropbox·GitLab 과 같은 결정). 본문은 스탯 대조로 변경분만 실린다.
 */
export async function pullGitHubChanges(
  client: GitHubIngestClient,
  repoFullName: string,
  known: GitHubKnown,
): Promise<GitHubPull> {
  let repo: GitHubRepoInfo;
  try {
    repo = await client.getRepo(repoFullName);
  } catch (e) {
    if (e instanceof GitHubApiError && (e.status === 401 || e.status === 404 || (e.status === 403 && e.retryAfterMs === undefined))) {
      // 404 의 가장 흔한 꼴은 「비공개 저장소 + 앱 미설치」다 (ISSUE-501) — 설치 길을 먼저
      // 가리키고, 소유자 퇴장(워크스페이스 토큰은 연결 소유자를 탄다)은 그다음 안내다.
      throw new GitHubAuthError([
        `연결 자격이 저장소에 닿지 않습니다 (${e.status}) — 비공개 저장소는 OntoFlow 허브 GitHub 앱이 그 저장소에 설치되어 있어야 보입니다: github.com/apps/ontoflow-hub/installations/new 에서 저장소를 더해 주세요. 설치 뒤에도 계속되면 연결 소유자의 자격이 끊긴 것입니다 — 콘솔에서 GitHub 를 다시 연결해 주세요`,
      ]);
    }
    throw e;
  }
  if (known.cursor !== null) {
    const cursor = known.cursor;
    const delta = (await client.listIssues(repoFullName, cursor)).filter((i) => i.updatedAt > cursor);
    if (delta.length === 0) return { cursor, unchanged: true, items: [] };
  }
  const issues = await client.listIssues(repoFullName, null);
  const items: GitHubPulledItem[] = [];
  let cursor = known.cursor;
  for (const issue of issues) {
    const mtime = Date.parse(issue.updatedAt);
    if (Number.isNaN(mtime)) throw new GitHubError([`이슈 수정 시각이 날짜가 아니다: ${issueId(issue.number)}`]);
    if (cursor === null || issue.updatedAt > cursor) cursor = issue.updatedAt;
    // 코멘트는 변경 이슈에만 (ISSUE-529) — 무변 항목은 본문도 코멘트도 다시 나르지 않는다.
    const changed = known.files[issueId(issue.number)] !== mtime;
    let md: string | null = null;
    if (changed) {
      const comments =
        client.listComments === undefined ? [] : await client.listComments(repoFullName, issue.number);
      md = issueNoteMd(issue, comments);
    }
    items.push({
      id: issueId(issue.number),
      title: issue.title,
      mtime,
      md,
      visibility: repo.visibility,
    });
  }
  return { cursor, unchanged: false, items };
}

/** 플러그인 면 — #55 수집 상태에서 known 을 만든다 (커서는 CollectState.cursor 자리). */
export function githubKnownOf(state: CollectState, sourceId: string): GitHubKnown {
  const cursor = state.cursor;
  return { cursor: typeof cursor === "string" ? cursor : null, files: sourceKnownStats(state, sourceId) };
}

/** 끌어온 묶음을 #55 경계로 편다 — 무변 묶음은 명시 거부 (빈 목록 = 전체 삭제 오판 방지). */
export function githubPulledReader(pull: GitHubPull): SourceReader {
  if (pull.unchanged) {
    throw new GitHubError(["무변 묶음이다 — 수집을 건너뛴다 (reconcile 에 들이밀면 전체 삭제로 오판한다)"]);
  }
  const byPath = new Map(pull.items.map((f) => [sourceEntryPath({ id: f.id, title: f.title }), f]));
  return {
    async list(): Promise<VaultFileStat[]> {
      return [...byPath.keys()].map((path) => ({ path, mtime: byPath.get(path)?.mtime ?? 0, size: 0 }));
    },
    async read(path: string): Promise<string> {
      const file = byPath.get(path);
      if (!file || file.md === null) {
        throw new GitHubError([`본문이 실려 오지 않은 항목이다 — known 과 수집 상태가 어긋난다: ${path}`]);
      }
      return file.md;
    },
  };
}
