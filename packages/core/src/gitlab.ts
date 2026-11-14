// GitLab 수집 어댑터 경계 (ISSUE-312 — moayo-hq#279 B안 편입 ①) — #62 Dropbox 와 같은 꼴:
// 읽기 연산뿐인 경계(쓰기 연산 자체가 없다 — AC3 의 구조면), HTTP 는 허브 어댑터
// (gitlab-http.ts), 자격증명·스코프 규율은 #60 금고가 진다. 닻은 프로젝트 전체 경로 하나다
// (인스턴스 전역은 최소 스코프 초과 — 그룹 수집은 비범위·재론).
//
// 증분의 두 결 (AC1): 이슈는 `updated_at` 커서가 공짜지만 **위키 목록에는 타임스탬프가 없다**
// — 그래서 위키는 내용 해시를 mtime 자리에 쓴다: 무변 내용은 같은 스탬프라 재수집 0 이고,
// 결정적이라 재현 가능하다. 삭제는 #55 재대조(목록 부재 = 삭제)가 가린다 — 둘 다 전량
// 목록을 돌려주는 이유다.
//
// 1비트 (AC2 — #218 최종 모델 정합): 공유는 구성원 직접 표시·기본 비공유가 정본이라 소스
// ACL 유도 자동 공유가 애초에 없다. `confidential` 은 **메타데이터로 보존**만 한다 — 이
// 모듈 산출 어디에도 공유 기록 꼴이 없는 것이 구조 증명이다.
import type { CollectState, VaultFileStat } from "./collect.js";
import { sourceEntryPath, sourceKnownStats, type SourceReader } from "./sources.js";
import { GITLAB_ALLOWED_SCOPES } from "./oauth-scopes.js"; // 잎 — 금고 본체를 번들로 끌고 가지 않는다

export class GitLabError extends Error {
  constructor(readonly problems: string[]) {
    super(`GitLab 수집 거부:\n- ${problems.join("\n- ")}`);
    this.name = "GitLabError";
  }
}

// ---- 스코프 핀 · 레이트리밋 · 후퇴 (어댑터 집행 — #62 와 같은 규율) ----

/** 요청 스코프의 전부 — `read_api` 하나: 쓰기 급(`api`)은 요청 밖이라 부여 즉시 422 다 (AC3). */
export const GITLAB_INGEST_SCOPES = GITLAB_ALLOWED_SCOPES;

export const GITLAB_MIN_INTERVAL_MS = 200;
export const GITLAB_BACKOFF_BASE_MS = 1000;
export const GITLAB_BACKOFF_MAX_RETRIES = 3;

export class GitLabApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "GitLabApiError";
  }
}

/** 후퇴 대상 판정 — 429 뿐이다: 그 밖은 재시도 폭주의 입구라 즉시 실패다. */
export function isGitLabBackoffTarget(e: unknown): boolean {
  return e instanceof GitLabApiError && e.status === 429;
}

// ---- 클라이언트 경계 — 읽기 연산 둘뿐이다 ----

export interface GitLabIssueEntry {
  iid: number;
  title: string;
  /** RFC3339 updated_at — 이슈 커서의 재료다. */
  updatedAt: string;
  confidential: boolean;
  /** 목록 응답에 본문이 동승한다 — 항목별 본문 호출 0 이 이 API 의 값이다. */
  descriptionMd: string | null;
}

export interface GitLabWikiPage {
  slug: string;
  title: string;
  /** markdown 외 포맷(rdoc·asciidoc·org)은 코어가 거른다 — 건수만 센다. */
  format: string;
  md: string;
}

export interface GitLabIngestClient {
  /** updatedAfter 가 null 이면 전량, 아니면 그 이후 변경분만 — 페이지 소비는 어댑터 몫. */
  listIssues(projectPath: string, updatedAfter: string | null): Promise<GitLabIssueEntry[]>;
  /** 위키 전량(본문 동승) — 목록에 시각이 없어 증분 문이 따로 없다. */
  listWikiPages(projectPath: string): Promise<GitLabWikiPage[]>;
}

// ---- 위키 스탬프 — 내용 해시(FNV-1a 32bit)를 mtime 자리에 쓴다: 결정적·무변 재수집 0 ----

export function gitlabContentStamp(md: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < md.length; i += 1) {
    h ^= md.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

const issueId = (iid: number): string => `i-${iid}`;
const wikiId = (slug: string): string => `w-${slug}`;

// ---- 커서 증분 (AC1) ----

export interface GitLabPulledItem {
  id: string;
  title: string;
  mtime: number;
  /** 변경분만 md 가 실린다 — 무변 항목은 본문을 다시 나르지 않는다. */
  md: string | null;
  /** 메타데이터 보존 (AC2) — 공유 비트가 아니다: 공유는 구성원 직접 표시만이 만든다. */
  confidential: boolean;
}

export interface GitLabPull {
  /** 다음 known.cursor — 이번 목록의 최대 updated_at (이슈 0 이면 이전 값 유지). */
  cursor: string | null;
  /** true 면 이슈 델타 0 + 위키 무변 — 전량 목록 없이 끝났다 (AC1 의 싼 문). */
  unchanged: boolean;
  items: GitLabPulledItem[];
  /** markdown 외 위키 건수 — 이름·내용은 나르지 않는다 (zero-retention 지표 규율). */
  skippedNonMarkdown: number;
}

export interface GitLabKnown {
  cursor: string | null;
  files: Record<string, number>;
}

function wikiItems(
  pages: GitLabWikiPage[],
  known: GitLabKnown,
): { items: GitLabPulledItem[]; skipped: number; unchanged: boolean } {
  const items: GitLabPulledItem[] = [];
  let skipped = 0;
  for (const page of pages) {
    if (page.format !== "markdown") {
      skipped += 1;
      continue;
    }
    const stamp = gitlabContentStamp(page.md);
    items.push({
      id: wikiId(page.slug),
      title: page.title,
      mtime: stamp,
      md: known.files[wikiId(page.slug)] === stamp ? null : page.md,
      confidential: false,
    });
  }
  const current = new Set(items.map((i) => i.id));
  const removed = Object.keys(known.files).some((id) => id.startsWith("w-") && !current.has(id));
  const changed = removed || items.some((i) => i.md !== null);
  return { items, skipped, unchanged: !changed };
}

/**
 * 허브 면의 증분 판정 — ① 커서가 있으면 이슈 델타 + 위키 스탬프 대조로 무변을 싸게 가린다.
 * ② 변경이 있거나 첫 수집이면 이슈 전량 재목록 — 부재 = 삭제의 재대조(#55) 한 꼴로 통일한다
 * (Dropbox 와 같은 결정). 본문은 스탯 대조로 변경분만 실린다.
 */
export async function pullGitLabChanges(
  client: GitLabIngestClient,
  projectPath: string,
  known: GitLabKnown,
): Promise<GitLabPull> {
  const wikis = wikiItems(await client.listWikiPages(projectPath), known);
  if (known.cursor !== null) {
    const delta = await client.listIssues(projectPath, known.cursor);
    if (delta.length === 0 && wikis.unchanged) {
      return { cursor: known.cursor, unchanged: true, items: [], skippedNonMarkdown: wikis.skipped };
    }
  }
  const issues = await client.listIssues(projectPath, null);
  const items: GitLabPulledItem[] = [...wikis.items];
  let cursor = known.cursor;
  for (const issue of issues) {
    const mtime = Date.parse(issue.updatedAt);
    if (Number.isNaN(mtime)) throw new GitLabError([`이슈 수정 시각이 날짜가 아니다: ${issueId(issue.iid)}`]);
    if (cursor === null || issue.updatedAt > cursor) cursor = issue.updatedAt;
    items.push({
      id: issueId(issue.iid),
      title: issue.title,
      mtime,
      md: known.files[issueId(issue.iid)] === mtime ? null : issue.descriptionMd ?? "",
      confidential: issue.confidential,
    });
  }
  return { cursor, unchanged: false, items, skippedNonMarkdown: wikis.skipped };
}

/** 플러그인 면 — #55 수집 상태에서 known 을 만든다 (커서는 CollectState.cursor 자리). */
export function gitlabKnownOf(state: CollectState, sourceId: string): GitLabKnown {
  const cursor = state.cursor;
  return { cursor: typeof cursor === "string" ? cursor : null, files: sourceKnownStats(state, sourceId) };
}

/** 끌어온 묶음을 #55 경계로 편다 — 무변 묶음은 명시 거부 (빈 목록 = 전체 삭제 오판 방지). */
export function gitlabPulledReader(pull: GitLabPull): SourceReader {
  if (pull.unchanged) {
    throw new GitLabError(["무변 묶음이다 — 수집을 건너뛴다 (reconcile 에 들이밀면 전체 삭제로 오판한다)"]);
  }
  const byPath = new Map(pull.items.map((f) => [sourceEntryPath({ id: f.id, title: f.title }), f]));
  return {
    async list(): Promise<VaultFileStat[]> {
      return [...byPath.keys()].map((path) => ({ path, mtime: byPath.get(path)?.mtime ?? 0, size: 0 }));
    },
    async read(path: string): Promise<string> {
      const file = byPath.get(path);
      if (!file || file.md === null) {
        throw new GitLabError([`본문이 실려 오지 않은 항목이다 — known 과 수집 상태가 어긋난다: ${path}`]);
      }
      return file.md;
    },
  };
}
