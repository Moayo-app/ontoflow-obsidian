// Evernote 수집 어댑터 경계 (ISSUE-98 — MCP 재개정, 구 ISSUE-57) — Tier B 둘째 표면
// (moayo-hq#279 상한 안, 꼴 변경·수 무변). #56 OneNote 와 같은 꼴로 #55 수집 경계
// (SourceReader)에 꽂힌다 — 이 모듈은 변환·판정만 들고, MCP 전송은 허브 어댑터
// (evernote-mcp.ts), 금고 규율·동의는 #60 몫이다.
//
// 구조 (#98 AC2): 읽기 전용 강제는 전송 층 스코프(수집 read · 출고 create — vault 허용목록)가
// 1축이고, 수집 클라이언트(읽기 연산뿐)/합성 출고 클라이언트(쓰기 연산뿐)의 타입 분리가 2축이다.
// 메아리 차단(AC4)은 태그(목록 단계 필터 — 본문 호출조차 없다) + 본문 frontmatter 마커
// (collect.isMachineAuthored 가 무는 꼴)의 이중 축이다.
import type { CollectState, VaultFileStat } from "./collect.js";
import { sourceEntryPath, sourceIssueMd, sourceKnownStats, type SourceReader } from "./sources.js";

export class EvernoteError extends Error {
  constructor(readonly problems: string[]) {
    super(`Evernote 수집 거부:\n- ${problems.join("\n- ")}`);
    this.name = "EvernoteError";
  }
}

// ---- 레이트리밋 · 마커 ----

/** MCP 레이트리밋은 베타 미문서 — 호출 간격 바닥 500ms (보수 핀, Graph 와 같은 규율). */
export const EVERNOTE_MIN_INTERVAL_MS = 500;

/** ontoflow 가 만든 노트의 태그 마커 (#98 AC4 1축) — 목록 단계에서 걸러진다. */
export const EVERNOTE_MARKER_TAG = "ontoflow-written";

// 전송 오류 — 어댑터가 상태와 재시도 대기(초→ms)를 실어 던진다 (단절은 status 0).
export class EvernoteApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "EvernoteApiError";
  }
}

// ---- 클라이언트 경계 — 수집(읽기뿐)과 합성 출고(쓰기뿐)의 물리적 분리 (AC2·AC6) ----

export interface EvernoteNoteStat {
  guid: string;
  title: string;
  /** 수정 시각 — epoch ms. 증분 선별의 노트 단위 기준이다. */
  updated: number;
  /** 태그 — EVERNOTE_MARKER_TAG 가 있으면 우리 산출이라 수집 제외다 (#98 AC4). */
  tags?: string[];
  /** 작성자 (ISSUE-540) — 노트 속성 author 문자열 그대로. 코멘트 API 는 없다(비채택 기록). */
  author?: string | null;
}

// 읽기 연산 둘뿐이다 — 노트북 한 곳의 목록·본문 (MCP search_notes·get_note). 노트북 id 는
// 금고 자격증명의 최소 스코프 닻에서 온다. 스코프(read)가 전송 층을 이미 막고, 이 타입
// 경계가 2축이다 (#98 AC2).
export interface EvernoteIngestClient {
  listNotes(notebookGuid: string): Promise<EvernoteNoteStat[]>;
  /** 본문 — 포맷 불문(베타 미문서): noteContentToMd 가 정규화한다. */
  getNoteContent(guid: string): Promise<string>;
}

// 쓰기 연산 하나뿐이다 — 합성 노트 생성 (#59 출고 · MCP create_note). 마커 태그는 호출자가
// 명시로 싣는다 — 마커 없는 생성이 타입에서 막힌다 (#98 AC4).
export interface EvernoteSynthesisClient {
  createNote(
    notebookGuid: string,
    note: { title: string; md: string; markerTag: string },
  ): Promise<{ guid: string }>;
}

// ---- ENML → md 정규화 (AC1) — 추출 입력 꼴 통일 ----

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

/**
 * ENML → md. OneNote 변환과 같은 보수 변환이다 — 추출 입력으로 충분한 평문 md 가 목표고,
 * en-media(첨부)·en-crypt(암호 블록)는 비범위라 벗긴다. en-todo 는 체크리스트로 번역된다.
 */
export function enmlToMd(enml: string): string {
  const body = /<en-note[^>]*>([\s\S]*?)<\/en-note>/i.exec(enml)?.[1] ?? enml;
  let text = body
    .replace(/<en-crypt[^>]*>[\s\S]*?<\/en-crypt>/gi, "")
    .replace(/<en-media[^>]*\/?>(?:<\/en-media>)?/gi, "")
    .replace(/<en-todo[^>]*checked="true"[^>]*\/?>/gi, "[x] ")
    .replace(/<en-todo[^>]*\/?>/gi, "[ ] ")
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
  return text === "" ? "" : `${text}\n`;
}

/**
 * 본문 → md 정규화 (#98 착수 판정 7) — MCP 본문 포맷이 베타 미문서라 꼴로 가른다:
 * ENML/HTML 꼴(닫는 태그 존재)이면 기존 변환, 아니면 md/평문 통과.
 */
export function noteContentToMd(content: string): string {
  if (/<en-note/i.test(content) || /<\/[a-z][^>]*>/i.test(content)) return enmlToMd(content);
  const text = content.trim();
  return text === "" ? "" : `${text}\n`;
}

/** 합성 노트(#59) md 의 본문 마커 (#98 AC4 2축) — collect.isMachineAuthored 가 무는 꼴 그대로. */
export function synthesisNoteMd(md: string): string {
  return `---\nwritten-by: ontoflow\n---\n\n${md}`;
}

// ---- 증분 수집 — MCP 에는 계정 동기 카운터가 없다: 목록 1호출이 바닥, 본문은 변경분만 ----

/** 노트 경로의 꼴 — API 소스 공통 (sources.ts): `<노트guid>/<제목>.md`. */
export function evernoteNotePath(note: { guid: string; title: string }): string {
  return sourceEntryPath({ id: note.guid, title: note.title });
}

export interface EvernotePulledNote {
  guid: string;
  title: string;
  mtime: number;
  /** 변경분만 md 가 실린다 — 무변 노트는 본문 호출 0. */
  md: string | null;
}

export interface EvernotePull {
  /** 이번 수집이 본 최신 수정 시각(ms, 비면 0) — 참고 커서다: 무변 판정은 목록 대조가 한다. */
  syncState: number;
  /** true 면 목록이 known 과 완전 일치 — 본문 호출 0 에 reconcile 도 건너뛴다. */
  unchanged: boolean;
  notes: EvernotePulledNote[];
}

export interface EvernoteKnown {
  /** 지난 수집의 커서 — MCP 재개정(#98) 뒤로는 참고값이다 (무변 판정에 쓰지 않는다). */
  syncState: number | null;
  /** {노트guid → mtime} — #55 수집 상태에서 만든다. */
  notes: Record<string, number>;
}

/**
 * 허브 면의 증분 판정 (#98) — MCP 에는 EDAM updateCount 등가물이 없어 목록 1호출이 바닥이다.
 * 목록이 known 과 완전 일치(같은 집합·같은 mtime)면 unchanged — 본문 호출 0. 달라졌으면
 * 변경 노트만 본문을 읽는다. ontoflow 마커 태그 노트는 목록 단계에서 걸러진다 — 본문
 * 호출조차 없다 (AC4).
 */
export async function pullEvernoteChanges(
  client: EvernoteIngestClient,
  notebookGuid: string,
  known: EvernoteKnown,
): Promise<EvernotePull> {
  const stats = (await client.listNotes(notebookGuid)).filter(
    (n) => !(n.tags ?? []).includes(EVERNOTE_MARKER_TAG),
  );
  let cursor = 0;
  for (const stat of stats) {
    if (!Number.isFinite(stat.updated)) throw new EvernoteError([`노트 수정 시각이 수가 아니다: ${stat.guid}`]);
    if (stat.updated > cursor) cursor = stat.updated;
  }
  const sameSet =
    stats.length === Object.keys(known.notes).length && stats.every((s) => known.notes[s.guid] === s.updated);
  if (sameSet) {
    return { syncState: cursor, unchanged: true, notes: [] };
  }
  const notes: EvernotePulledNote[] = [];
  for (const stat of stats) {
    const changed = known.notes[stat.guid] !== stat.updated;
    notes.push({
      guid: stat.guid,
      title: stat.title,
      mtime: stat.updated,
      // 작성 줄 합성 (ISSUE-540) — 코멘트 없는 소스라 작성자만: 속성 부재면 본문 그대로다.
      md: changed
        ? sourceIssueMd({ author: stat.author, body: noteContentToMd(await client.getNoteContent(stat.guid)) }, [])
        : null,
    });
  }
  return { syncState: cursor, unchanged: false, notes };
}

/** 플러그인 면 — #55 수집 상태에서 known 을 만든다 (커서는 CollectState.cursor 자리). */
export function evernoteKnownOf(state: CollectState, sourceId: string): EvernoteKnown {
  const cursor = state.cursor;
  return { syncState: typeof cursor === "number" ? cursor : null, notes: sourceKnownStats(state, sourceId) };
}

/**
 * 끌어온 묶음을 #55 경계(SourceReader)로 편다 — collectSource 가 그대로 돈다 (AC1).
 * unchanged 묶음은 호출자가 reconcile 자체를 건너뛴다 — 빈 목록을 들이밀면 전체 삭제로
 * 오판하므로, 이 함수가 명시로 거부한다.
 */
export function evernotePulledReader(pull: EvernotePull): SourceReader {
  if (pull.unchanged) {
    throw new EvernoteError(["무변 묶음이다 — 수집을 건너뛴다 (reconcile 에 들이밀면 전체 삭제로 오판한다)"]);
  }
  const byPath = new Map(pull.notes.map((n) => [evernoteNotePath(n), n]));
  return {
    async list(): Promise<VaultFileStat[]> {
      return [...byPath.keys()].map((path) => ({ path, mtime: byPath.get(path)?.mtime ?? 0, size: 0 }));
    },
    async read(path: string): Promise<string> {
      const note = byPath.get(path);
      if (!note || note.md === null) {
        throw new EvernoteError([`본문이 실려 오지 않은 노트다 — known 과 수집 상태가 어긋난다: ${path}`]);
      }
      return note.md;
    },
  };
}
