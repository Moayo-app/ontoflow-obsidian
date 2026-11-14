// OneNote 수집 어댑터 경계 (ISSUE-56) — Tier B 첫 표면: MS Graph API 읽기 전용 수집,
// 외부 상시 표면 +1 (상한 6 안 — moayo-hq#279). 수집 경계의 꼴은 #55 가 정했다: 이 모듈은
// OneNote 를 그 경계(SourceReader — 읽기 연산뿐)에 꽂는 변환·판정만 들고, HTTP 는 허브
// 어댑터(onenote-http.ts), 금고 규율·동의 문안은 #60 몫이다.
//
// 구조 (AC2·AC6): 수집 클라이언트(읽기 연산뿐)와 합성 출고 클라이언트(쓰기 연산뿐)는 별개
// 인터페이스 + 별개 자격증명(#60 분리 꼴) — 교차 사용이 타입부터 막힌다. 투영의 되읽기 0
// 증명(스펙 AC27)과 쌍대로, 수집 쪽에는 쓰기 연산 자체가 없다.
import type { CollectState, VaultFileStat } from "./collect.js";
import { sourceEntryPath, sourceKnownStats, type SourceReader } from "./sources.js";

export class OneNoteError extends Error {
  constructor(readonly problems: string[]) {
    super(`OneNote 수집 거부:\n- ${problems.join("\n- ")}`);
    this.name = "OneNoteError";
  }
}

// ---- API 버전 핀 · 레이트리밋 · 스코프 (Notion 어댑터 규율 승계) ----

export const GRAPH_API_BASE = "https://graph.microsoft.com/v1.0";
/** OneNote API 는 사용자당 분당 호출 상한이 좁다 — 호출 간격 바닥 500ms (보수 핀). */
export const GRAPH_MIN_INTERVAL_MS = 500;

/** 수집 자격증명이 요청할 수 있는 스코프의 전부 — 쓰기 스코프 0 이 AC2 다. */
export const ONENOTE_INGEST_SCOPES = ["Notes.Read"] as const;
/** 합성 출고(#59) 자격증명의 스코프 — 페이지 생성뿐, 기존 노트 읽기·수정 없음. */
export const ONENOTE_SYNTHESIS_SCOPES = ["Notes.Create"] as const;

// 전송 오류 — 어댑터가 상태 코드와 Retry-After 를 실어 던진다 (전송 단절은 status 0).
export class OneNoteApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "OneNoteApiError";
  }
}

// ---- 클라이언트 경계 — 수집(읽기뿐)과 합성 출고(쓰기뿐)의 물리적 분리 (AC2·AC6) ----

export interface OneNotePageStat {
  id: string;
  title: string;
  /** Graph lastModifiedDateTime — 증분 선별(AC4)의 유일한 기준이다. */
  lastModified: string;
}

// 읽기 연산 둘뿐이다 — 섹션 한 곳의 페이지 목록·본문. 섹션 id 는 금고 자격증명의
// 최소 스코프 닻(Notion targetPageId 와 같은 꼴)에서 온다.
export interface OneNoteIngestClient {
  listPages(sectionId: string): Promise<OneNotePageStat[]>;
  getPageHtml(pageId: string): Promise<string>;
}

// 쓰기 연산 하나뿐이다 — 합성 노트의 페이지 생성 (#59 출고). 읽기 연산이 없는 것이
// 이 방향의 구조 증명이다 — 합성 출고용 자격증명으로는 수집이 성립할 수 없다.
export interface OneNoteSynthesisClient {
  createPage(sectionId: string, title: string, html: string): Promise<{ id: string }>;
}

// ---- 페이지(HTML) → md 정규화 (AC1) — 추출 입력 꼴 통일 ----

const ENTITIES: Record<string, string> = {
  "&nbsp;": " ",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
};

function decodeEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&(nbsp|lt|gt|quot|#39|apos);/g, (m) => ENTITIES[m] ?? m)
    .replace(/&amp;/g, "&"); // 마지막 — 이중 디코드 방지
}

/** ontoflow 가 만든 페이지의 마커 (AC7) — head 의 meta 로 든다 (#59 「페이지/노트 메타」 꼴). */
export const ONENOTE_MARKER_META = '<meta name="written-by" content="ontoflow" />';

function hasMachineMarker(html: string): boolean {
  return /<meta[^>]*name="written-by"[^>]*content="ontoflow"[^>]*>|<meta[^>]*content="ontoflow"[^>]*name="written-by"[^>]*>/i.test(
    html,
  );
}

/**
 * OneNote 페이지 HTML → md. 전부 정규화하려는 게 아니다 — 추출 입력으로 충분한 평문 md 를
 * 얻는 보수 변환이다 (표·그림 등 남는 태그는 벗긴다, 이미지 OCR 은 비범위). ontoflow 마커
 * 페이지는 frontmatter `written-by: ontoflow` 로 번역된다 — #55 의 isMachineAuthored 가
 * 그대로 서서 수집 산출 0 이 된다 (AC7: API 쪽 메아리 차단).
 */
export function oneNoteHtmlToMd(html: string): string {
  const machine = hasMachineMarker(html);
  const body = /<body[^>]*>([\s\S]*?)<\/body>/i.exec(html)?.[1] ?? html;
  let text = body
    .replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_, code: string) => `\n\`\`\`\n${code}\n\`\`\`\n`)
    .replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, "`$1`")
    .replace(/<a\s[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, "[$2]($1)")
    .replace(/<h([1-6])[^>]*>/gi, (_, n: string) => `\n${"#".repeat(Number(n))} `)
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<(b|strong)[^>]*>([\s\S]*?)<\/\1>/gi, "**$2**")
    .replace(/<(i|em)[^>]*>([\s\S]*?)<\/\1>/gi, "*$2*")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|li|ul|ol|tr|table)>/gi, "\n")
    .replace(/<[^>]+>/g, "");
  text = decodeEntities(text)
    .split("\n")
    .map((l) => l.replace(/[ \t]+$/, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const md = text === "" ? "" : `${text}\n`;
  return machine ? `---\nwritten-by: ontoflow\n---\n${md}` : md;
}

/** 합성 노트(#59) → OneNote 페이지 HTML — 마커 meta 를 달아 재수집이 스스로 걸러진다 (AC7). */
export function synthesisPageHtml(title: string, md: string): string {
  const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const paragraphs = md
    .split("\n")
    .map((line) => `<p>${esc(line)}</p>`)
    .join("\n");
  return `<!DOCTYPE html>\n<html>\n<head>\n<title>${esc(title)}</title>\n${ONENOTE_MARKER_META}\n</head>\n<body>\n${paragraphs}\n</body>\n</html>`;
}

// ---- 증분 수집 (AC4) — 변경 페이지만 본문을 읽는다 ----

/** 노트 경로의 꼴 — API 소스 공통 (sources.ts sourceEntryPath): `<페이지id>/<제목>.md`. */
export function oneNotePagePath(page: { id: string; title: string }): string {
  return sourceEntryPath(page);
}

export interface OneNotePulledPage {
  id: string;
  title: string;
  /** lastModified 의 epoch ms — #55 수집 상태의 mtime 자리. */
  mtime: number;
  /** 변경분만 md 가 실린다 — 무변 페이지는 본문 호출 0 (AC4). */
  md: string | null;
}

export interface OneNotePull {
  pages: OneNotePulledPage[];
}

/**
 * 허브 면의 증분 판정 (AC4) — 목록 1호출 + 변경 페이지 수만큼 본문 호출. known 은 플러그인이
 * #55 수집 상태에서 만든 {페이지id → mtime} 이다 — 같은 상태로 reconcile 이 다시 선별하므로
 * 두 판정은 늘 일치한다. 산출은 응답에만 실린다 — 버퍼 밖 저장 0 (AC3).
 */
export async function pullOneNotePages(
  client: OneNoteIngestClient,
  sectionId: string,
  known: Record<string, number>,
): Promise<OneNotePull> {
  const stats = await client.listPages(sectionId);
  const pages: OneNotePulledPage[] = [];
  for (const stat of stats) {
    const mtime = Date.parse(stat.lastModified);
    if (Number.isNaN(mtime)) throw new OneNoteError([`페이지 수정 시각이 날짜가 아니다: ${stat.id}`]);
    const changed = known[stat.id] !== mtime;
    pages.push({
      id: stat.id,
      title: stat.title,
      mtime,
      md: changed ? oneNoteHtmlToMd(await client.getPageHtml(stat.id)) : null,
    });
  }
  return { pages };
}

/** 플러그인 면 — #55 수집 상태에서 known 맵을 만든다 (API 소스 공통 꼴 — sources.ts). */
export function knownStatsOf(state: CollectState, sourceId: string): Record<string, number> {
  return sourceKnownStats(state, sourceId);
}

/**
 * 끌어온 묶음을 #55 경계(SourceReader)로 편다 — collectSource 가 그대로 돌아 디프·메아리
 * 차단·상태 갱신 전부 파일 소스와 같은 꼴이다 (AC1: 산출이 곧 추출 경로 API1 의 입력 큐다).
 * size 는 상수 0 — Graph 목록에 본문 크기가 없어 증분 선별은 mtime 만으로 선다.
 */
export function oneNotePulledReader(pull: OneNotePull): SourceReader {
  const byPath = new Map(pull.pages.map((p) => [oneNotePagePath(p), p]));
  return {
    async list(): Promise<VaultFileStat[]> {
      return [...byPath.keys()].map((path) => ({ path, mtime: byPath.get(path)?.mtime ?? 0, size: 0 }));
    },
    async read(path: string): Promise<string> {
      const page = byPath.get(path);
      if (!page || page.md === null) {
        throw new OneNoteError([`본문이 실려 오지 않은 페이지다 — known 맵과 수집 상태가 어긋난다: ${path}`]);
      }
      return page.md;
    },
  };
}
