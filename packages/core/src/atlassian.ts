// Atlassian 수집 어댑터 경계 (ISSUE-314 — moayo-hq#279 B안 편입 ③) — 한 3LO 자격으로
// 수집 둘(벤더 1 · API 2): Jira 이슈는 `updated` 커서 증분(#313 GitHub 꼴), Confluence
// 페이지는 내용 스탬프(#312 GitLab 위키 꼴 — v2 목록이 본문을 동승해 시각 의존이 없다).
// HTTP 는 허브 어댑터(atlassian-http.ts), 자격증명·스코프 규율은 #60 금고가 진다.
// 닻은 둘 다 자격증명에 산다(jiraProjectKey · confluenceSpaceKey) — 사이트 전역은 최소
// 스코프 초과다. 본문은 ADF 로 오고, 변환기(adfToMd)는 결정적이다.
//
// 1비트 (#215 정본 조사):
// - Jira 는 **상수**다 — 줄 수 있는 신호가 없다(accessLevel 은 GET 표면에 없고, isPrivate 는
//   정보량 0, 보안 수준은 의미가 어긋난다) ⇒ 「신호 없음 = 비공유」 상수. 항목에 필드 자체가
//   없는 것이 그 상수의 구조면이다.
// - Confluence 는 **공간 조회표**다(후보 1 채택 — restriction-state 는 상속 보정이 ~2N 이라
//   기각): personal 공간은 소유자 본인 것만 비공유, 남의 personal·그 밖은 공유 신호.
//   조회 실패·모름 = 비공유 (AC2 거짓 공개 금지). 이 신호는 **메타데이터 보존**이다 — 공유
//   그 자체는 구성원 직접 표시가 정본이다 (#218 최종 모델).
//
// ⚠️ 레이트리밋 (AC3) — Confluence 풀은 **앱 전역**이다: 429 재시도는 남의 워크스페이스
// 예산을 태우는 일이라 어댑터에 자동 재시도가 없고, 코어는 중단 + 재개 커서로 돌려준다.
import type { CollectState, VaultFileStat } from "./collect.js";
import { sourceEntryPath, sourceKnownStats, type SourceReader } from "./sources.js";
import { ATLASSIAN_ALLOWED_SCOPES } from "./oauth-scopes.js"; // 잎 — 금고 본체를 번들로 끌고 가지 않는다

export class AtlassianError extends Error {
  constructor(readonly problems: string[]) {
    super(`Atlassian 수집 거부:\n- ${problems.join("\n- ")}`);
    this.name = "AtlassianError";
  }
}

/** 자격 상실의 명시면 (#313 꼴) — 서버 라우트가 이 꼴만 재연결 안내 상태코드로 번역한다. */
export class AtlassianAuthError extends AtlassianError {
  constructor(problems: string[]) {
    super(problems);
    this.name = "AtlassianAuthError";
  }
}

// ---- 스코프 핀 · 레이트리밋 (어댑터 집행) ----

/** 요청 스코프의 전부 — 읽기 셋 + offline_access(refresh 재료): 쓰기 급은 요청 밖이라 즉시 422 다 (AC4). */
export const ATLASSIAN_INGEST_SCOPES = ATLASSIAN_ALLOWED_SCOPES;

export const ATLASSIAN_MIN_INTERVAL_MS = 200;

export class AtlassianApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "AtlassianApiError";
  }
}

const isAuthLoss = (e: unknown): e is AtlassianApiError =>
  e instanceof AtlassianApiError && (e.status === 401 || e.status === 404 || (e.status === 403 && e.retryAfterMs === undefined));

function authError(e: AtlassianApiError): AtlassianAuthError {
  return new AtlassianAuthError([
    `연결 자격이 더는 사이트에 닿지 않습니다 (${e.status}) — Atlassian refresh 토큰은 90일 무활동으로 만료되고 연결 소유자를 탑니다: 콘솔에서 Atlassian 을 다시 연결해 주세요`,
  ]);
}

// ---- 클라이언트 경계 — 읽기 연산뿐이다 ----

export interface JiraIssueEntry {
  /** 이슈 키 (예: ONTO-12) — 사이트 안 유일이라 그대로 항목 id 다. */
  key: string;
  summary: string;
  /** RFC3339 updated — 커서의 재료다. */
  updatedAt: string;
  /** ADF JSON 문자열 — md 변환은 코어(adfToMd) 몫이다. */
  descriptionAdf: string | null;
}

export interface ConfluenceSpaceInfo {
  id: string;
  key: string;
  /** SpaceType enum (global·personal·…) — 비트의 자리다 (#215 후보 1). */
  type: string;
  ownerId: string | null;
}

export interface ConfluencePageEntry {
  id: string;
  title: string;
  /** ADF JSON 문자열 (body-format=atlas_doc_format) — 목록에 본문이 동승한다. */
  adf: string;
}

export interface AtlassianIngestClient {
  /** 연결 사용자의 Atlassian account id — personal 공간 소유 대조의 재료다. */
  myAccountId(): Promise<string>;
  /** updatedAfter 가 null 이면 전량 — JQL 시각 여유·페이지 소비는 어댑터 몫 (초과분은 코어가 거른다). */
  listJiraIssues(projectKey: string, updatedAfter: string | null): Promise<JiraIssueEntry[]>;
  /** 공간 키 → 공간 정보 (없으면 null) — 비트 조회표는 공간 한 건으로 선다. */
  getSpace(spaceKey: string): Promise<ConfluenceSpaceInfo | null>;
  /** 페이지 한 배치 — 커서 페이징을 코어가 돌려야 429 중단·재개가 선다 (AC3). */
  listPageBatch(spaceId: string, cursor: string | null): Promise<{ pages: ConfluencePageEntry[]; nextCursor: string | null }>;
}

// ---- ADF → md — 결정적 변환: 같은 입력은 같은 출력이다 (스탬프의 전제) ----

type AdfNode = { type?: unknown; text?: unknown; attrs?: Record<string, unknown>; content?: unknown };

function inlineText(nodes: unknown): string {
  if (!Array.isArray(nodes)) return "";
  return nodes
    .map((raw) => {
      const n = raw as AdfNode;
      if (n.type === "text") return typeof n.text === "string" ? n.text : "";
      if (n.type === "hardBreak") return "\n";
      if (n.type === "mention" || n.type === "emoji") {
        const t = n.attrs?.text;
        return typeof t === "string" ? t : "";
      }
      return inlineText(n.content);
    })
    .join("");
}

function blockMd(raw: unknown, depth: number): string[] {
  const n = raw as AdfNode;
  const children = Array.isArray(n.content) ? n.content : [];
  if (n.type === "paragraph") {
    const text = inlineText(children);
    return text.length === 0 ? [] : [text];
  }
  if (n.type === "heading") {
    const level = typeof n.attrs?.level === "number" ? Math.min(Math.max(n.attrs.level, 1), 6) : 1;
    return [`${"#".repeat(level)} ${inlineText(children)}`];
  }
  if (n.type === "codeBlock") {
    return ["```\n" + inlineText(children) + "\n```"];
  }
  if (n.type === "blockquote") {
    return children.flatMap((c) => blockMd(c, depth)).map((line) => `> ${line}`);
  }
  if (n.type === "bulletList" || n.type === "orderedList") {
    const marker = n.type === "bulletList" ? "-" : "1.";
    const lines = children.flatMap((item) => {
      const itemNode = item as AdfNode;
      const inner = (Array.isArray(itemNode.content) ? itemNode.content : []).flatMap((c) => blockMd(c, depth + 1));
      return inner.map((line, i) => `${"  ".repeat(depth)}${i === 0 ? `${marker} ` : "  "}${line}`);
    });
    // 목록은 한 블록이다 — 항목 사이를 빈 줄 없이 잇는다 (doc 결합은 블록 사이에 빈 줄을 둔다).
    return lines.length === 0 ? [] : [lines.join("\n")];
  }
  if (n.type === "rule") return ["---"];
  // 모르는 블록은 자식으로 내려간다 — 표·패널 등도 텍스트는 건진다 (결정적 폴백).
  return children.flatMap((c) => blockMd(c, depth));
}

/** ADF JSON 문자열 → markdown. null 은 빈 본문이고, JSON·꼴이 어긋나면 명시 거부다 (닫힌 기본). */
export function adfToMd(adf: string | null): string {
  if (adf === null) return "";
  let doc: unknown;
  try {
    doc = JSON.parse(adf);
  } catch {
    throw new AtlassianError(["본문이 ADF JSON 이 아니다 — 공급자 응답 꼴이 어긋난다"]);
  }
  if (typeof doc !== "object" || doc === null || (doc as AdfNode).type !== "doc") {
    throw new AtlassianError(["본문 루트가 ADF doc 이 아니다 — 공급자 응답 꼴이 어긋난다"]);
  }
  const content = (doc as AdfNode).content;
  return (Array.isArray(content) ? content : []).flatMap((c) => blockMd(c, 0)).join("\n\n");
}

// ---- 내용 스탬프 (FNV-1a 32bit) — #312 위키와 같은 결: 결정적·무변 재수집 0 ----

export function atlassianContentStamp(md: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < md.length; i += 1) {
    h ^= md.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// ---- Jira — 커서 증분 (AC1, #313 꼴) ----

export interface JiraPulledItem {
  id: string;
  title: string;
  mtime: number;
  md: string | null;
  // 1비트 필드가 없다 — Jira 는 신호를 못 줘 「신호 없음 = 비공유」 상수다 (#215 결).
}

export interface JiraPull {
  cursor: string | null;
  unchanged: boolean;
  items: JiraPulledItem[];
}

export interface JiraKnown {
  cursor: string | null;
  files: Record<string, number>;
}

const jiraId = (key: string): string => key;

/**
 * 허브 면의 증분 판정 — ① 커서가 있으면 델타로 무변을 싸게 가린다 (어댑터의 JQL 시각 여유
 * 때문에 과거분이 섞여 와도 코어가 > 로 거른다 — 놓침 0·중복 0). ② 변경이 있거나 첫 수집이면
 * 전량 재목록 — 본문은 스탯 대조로 변경분만 실린다. 자격 상실은 명시 오류다 (#313 꼴).
 */
export async function pullJiraChanges(client: AtlassianIngestClient, projectKey: string, known: JiraKnown): Promise<JiraPull> {
  let issues: JiraIssueEntry[];
  try {
    if (known.cursor !== null) {
      const cursor = known.cursor;
      const delta = (await client.listJiraIssues(projectKey, cursor)).filter((i) => i.updatedAt > cursor);
      if (delta.length === 0) return { cursor, unchanged: true, items: [] };
    }
    issues = await client.listJiraIssues(projectKey, null);
  } catch (e) {
    if (isAuthLoss(e)) throw authError(e);
    throw e;
  }
  const items: JiraPulledItem[] = [];
  let cursor = known.cursor;
  for (const issue of issues) {
    const mtime = Date.parse(issue.updatedAt);
    if (Number.isNaN(mtime)) throw new AtlassianError([`이슈 수정 시각이 날짜가 아니다: ${jiraId(issue.key)}`]);
    if (cursor === null || issue.updatedAt > cursor) cursor = issue.updatedAt;
    items.push({
      id: jiraId(issue.key),
      title: issue.summary,
      mtime,
      md: known.files[jiraId(issue.key)] === mtime ? null : adfToMd(issue.descriptionAdf),
    });
  }
  return { cursor, unchanged: false, items };
}

// ---- Confluence — 내용 스탬프 + 전역 예산 가드 (AC2·AC3) ----

export interface ConfluencePulledItem {
  id: string;
  title: string;
  mtime: number;
  md: string | null;
  /**
   * 소스의 공유 신호 환원 (#215 후보 1) — 공유 그 자체가 아니다: 공유는 구성원 직접 표시가
   * 정본(#218)이고, 이 값은 보존 메타데이터다. false = 본인 personal 공간 또는 모름 (AC2).
   */
  sharedSignal: boolean;
}

export interface ConfluencePull {
  /** false 면 전역 레이트리밋으로 중단됐다 — resumeCursor 로 이어 받는다 (AC3). */
  complete: boolean;
  /** 중단 지점의 페이지 커서 — complete 면 null. */
  resumeCursor: string | null;
  /** true 면 중단 지점에서 이어 받은 **꼬리** 목록이다 — 단독으론 전량이 아니라서
   * reader 가 거부한다: combine 으로 머리와 붙여야 완결이다 (AC3 안전면). */
  tail: boolean;
  unchanged: boolean;
  items: ConfluencePulledItem[];
}

export interface ConfluenceKnown {
  resumeCursor: string | null;
  files: Record<string, number>;
}

const confluenceId = (pageId: string): string => `c-${pageId}`;

function spaceSignal(space: ConfluenceSpaceInfo, myAccountId: string): boolean {
  // personal 공간: 소유자 본인 것만 비공유 — 남의 personal 에 닿았다는 것이 공유의 증거다.
  // 소유자를 모르면(필드 부재) 비공유다 — 거짓 공개 금지 (AC2).
  if (space.type === "personal") return space.ownerId !== null && space.ownerId !== myAccountId;
  // 모르는 type 도 비공유 쪽이다 — enum 밖 값은 「모름」이다.
  const KNOWN_OPEN = ["global", "collaboration", "knowledge_base", "system", "onboarding", "xflow_sample_space"];
  return KNOWN_OPEN.includes(space.type);
}

/**
 * 공간 조회 1회 + 페이지 배치 루프 — 배치 중 429 를 만나면 **그 자리에서 중단**하고 재개
 * 커서를 돌려준다 (AC3 — 어댑터에 자동 재시도가 없고, 여기서도 더 묻지 않는다: 전역 풀을
 * 태우지 않는 것이 가드다). 중단 묶음은 complete=false 라 reader 가 거부한다 — 이어 받아
 * combineConfluencePulls 로 완결한 뒤에 투입한다.
 */
export async function pullConfluencePages(
  client: AtlassianIngestClient,
  spaceKey: string,
  known: ConfluenceKnown,
): Promise<ConfluencePull> {
  let me: string;
  let space: ConfluenceSpaceInfo | null;
  try {
    me = await client.myAccountId();
    space = await client.getSpace(spaceKey);
  } catch (e) {
    if (isAuthLoss(e)) throw authError(e);
    throw e;
  }
  if (space === null) throw new AtlassianError([`공간을 찾을 수 없다: ${spaceKey} — 닻을 다시 확인한다`]);
  const signal = spaceSignal(space, me);
  const tail = known.resumeCursor !== null;
  const items: ConfluencePulledItem[] = [];
  let cursor = known.resumeCursor;
  for (;;) {
    let batch: { pages: ConfluencePageEntry[]; nextCursor: string | null };
    try {
      batch = await client.listPageBatch(space.id, cursor);
    } catch (e) {
      if (e instanceof AtlassianApiError && e.status === 429) {
        return { complete: false, resumeCursor: cursor, tail, unchanged: false, items };
      }
      if (isAuthLoss(e)) throw authError(e);
      throw e;
    }
    for (const page of batch.pages) {
      const md = adfToMd(page.adf);
      const stamp = atlassianContentStamp(md);
      items.push({
        id: confluenceId(page.id),
        title: page.title,
        mtime: stamp,
        md: known.files[confluenceId(page.id)] === stamp ? null : md,
        sharedSignal: signal,
      });
    }
    if (batch.nextCursor === null) break;
    cursor = batch.nextCursor;
  }
  // 완결 목록이 섰다 — 무변 판정: 전 항목 스탬프 일치 + known 의 부재(삭제) 없음.
  // 꼬리 목록에선 부재 대조가 거짓 삭제라 무변 판정을 하지 않는다 (combine 뒤의 전량이 정본).
  if (tail) return { complete: true, resumeCursor: null, tail, unchanged: false, items };
  const current = new Set(items.map((i) => i.id));
  const removed = Object.keys(known.files).some((id) => id.startsWith("c-") && !current.has(id));
  const changed = removed || items.some((i) => i.md !== null);
  return { complete: true, resumeCursor: null, tail, unchanged: !changed, items };
}

/** 중단된 묶음 잇기 (AC3) — 앞 묶음의 항목에 뒤 묶음을 이어 붙인다. 완결은 뒤 묶음이,
 * 머리 여부는 앞 묶음이 정한다 — 처음부터 받은 사슬만 combine 끝에 reader 를 통과한다. */
export function combineConfluencePulls(first: ConfluencePull, next: ConfluencePull): ConfluencePull {
  if (first.complete) throw new AtlassianError(["이미 완결된 묶음이다 — 이을 것이 없다"]);
  return {
    complete: next.complete,
    resumeCursor: next.resumeCursor,
    tail: first.tail,
    unchanged: false,
    items: [...first.items, ...next.items],
  };
}

// ---- 플러그인 면 — #55 수집 상태 접점 ----

export function jiraKnownOf(state: CollectState, sourceId: string): JiraKnown {
  const cursor = state.cursor;
  return { cursor: typeof cursor === "string" ? cursor : null, files: sourceKnownStats(state, sourceId) };
}

export function confluenceKnownOf(state: CollectState, sourceId: string): ConfluenceKnown {
  const cursor = state.cursor;
  return { resumeCursor: typeof cursor === "string" ? cursor : null, files: sourceKnownStats(state, sourceId) };
}

function readerOf(items: { id: string; title: string; mtime: number; md: string | null }[]): SourceReader {
  const byPath = new Map(items.map((f) => [sourceEntryPath({ id: f.id, title: f.title }), f]));
  return {
    async list(): Promise<VaultFileStat[]> {
      return [...byPath.keys()].map((path) => ({ path, mtime: byPath.get(path)?.mtime ?? 0, size: 0 }));
    },
    async read(path: string): Promise<string> {
      const file = byPath.get(path);
      if (!file || file.md === null) {
        throw new AtlassianError([`본문이 실려 오지 않은 항목이다 — known 과 수집 상태가 어긋난다: ${path}`]);
      }
      return file.md;
    },
  };
}

/** Jira 묶음을 #55 경계로 편다 — 무변 묶음은 명시 거부 (빈 목록 = 전체 삭제 오판 방지). */
export function jiraPulledReader(pull: JiraPull): SourceReader {
  if (pull.unchanged) {
    throw new AtlassianError(["무변 묶음이다 — 수집을 건너뛴다 (reconcile 에 들이밀면 전체 삭제로 오판한다)"]);
  }
  return readerOf(pull.items);
}

/** Confluence 묶음을 #55 경계로 편다 — 무변·**미완결** 묶음은 명시 거부: 부분 목록을
 * reconcile 에 들이밀면 뒷부분 전체가 삭제로 오판된다 (AC3 의 안전면). */
export function confluencePulledReader(pull: ConfluencePull): SourceReader {
  if (pull.unchanged) {
    throw new AtlassianError(["무변 묶음이다 — 수집을 건너뛴다 (reconcile 에 들이밀면 전체 삭제로 오판한다)"]);
  }
  if (!pull.complete || pull.tail) {
    throw new AtlassianError(["미완결·꼬리 묶음이다 — resumeCursor 로 이어 받아 combine 한 뒤 투입한다 (AC3 — 부분 목록은 전체 삭제로 오판된다)"]);
  }
  return readerOf(pull.items);
}
