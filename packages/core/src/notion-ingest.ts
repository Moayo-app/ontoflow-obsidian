// Notion 읽기 수집 경계 (ISSUE-240) — 기존 투영 표면의 역방향 추가라 외부 상시 표면 +0 이다
// (#227 결의 · moayo-hq#279 관행). 수집 경계의 꼴은 #55 가 정했다: 이 모듈은 Notion 을 그
// 경계(SourceReader — 읽기 연산뿐)에 꽂는 변환·판정만 들고, HTTP 는 허브 어댑터 몫이다.
//
// 구조 (AC4): 수집 클라이언트(읽기 연산뿐)는 투영 클라이언트(notion.ts — 쓰기 전용)와 물리적
// 으로 분리돼 서로 import 가 없다 (#55 AC2 규율 그대로) — 자격증명도 별개 kind(`notion-ingest`)
// 라 교차 사용이 꼴부터 막힌다. 투영의 되읽기 0 증명(스펙 AC27)과 쌍대로, 수집 쪽에는 쓰기
// 연산 자체가 없다.
import type { CollectState, VaultFileStat } from "./collect.js";
import { sourceEntryPath, sourceKnownStats, type SourceReader } from "./sources.js";

export class NotionIngestError extends Error {
  constructor(readonly problems: string[]) {
    super(`Notion 수집 거부:\n- ${problems.join("\n- ")}`);
    this.name = "NotionIngestError";
  }
}

// ---- API 버전 핀 · 레이트리밋 — 투영(notion.ts)과 같은 값이지만 import 하지 않는다:
// 수집·투영의 물리 분리(#55 AC2)가 상수 공유보다 비싸다. 버전 업은 두 모듈을 함께 올린다 ----

export const NOTION_INGEST_API_VERSION = "2022-06-28";
/** 평균 3 rps 준수 — 어댑터는 호출 간격을 이 아래로 좁히지 않는다 (투영과 같은 핀). */
export const NOTION_INGEST_MIN_INTERVAL_MS = 334;

// 전송 오류 — 어댑터가 상태 코드와 Retry-After 를 실어 던진다 (전송 단절은 status 0).
export class NotionIngestApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "NotionIngestApiError";
  }
}

// ---- 기계 자리의 표지 (AC3) — 투영이 만든 페이지는 본문 마커가 없다: 유일한 구조 표지는
// 부모 DB 의 제목이다 (허브 notion-http.ts 의 NODES_DB_TITLE·EDGES_DB_TITLE — 드리프트는
// 허브 테스트가 동일성 검사로 막는다). 그 DB 아래 페이지는 **통째 제외**다 — 사용자가
// 투영 행 페이지를 편집해도 재수집 0 (에코 차단) ----

export const NOTION_MACHINE_DB_TITLES = ["OntoFlow Nodes", "OntoFlow Edges"] as const;

export function isMachineDbTitle(title: string): boolean {
  return (NOTION_MACHINE_DB_TITLES as readonly string[]).includes(title);
}

// ---- 클라이언트 경계 — 읽기 연산 셋뿐이다 (AC4 의 구조 증명: 쓰기 연산이 없다) ----

export interface NotionPageStat {
  id: string;
  title: string;
  /** last_edited_time — 증분 선별(AC2)의 유일한 기준이다. */
  lastEdited: string;
  /** 부모 — DB 행 페이지면 그 DB 가 기계 자리인지 판별(AC3)의 입력이다. */
  parent: { kind: "database"; databaseId: string } | { kind: "other" };
}

/** 본문 블록의 수집 꼴 — 어댑터가 rich_text 를 평문으로 눕혀 싣는다 (주석·색은 버린다). */
export interface NotionIngestBlock {
  type: string;
  text: string;
  /** to_do 블록만. */
  checked?: boolean;
  /** code 블록만. */
  language?: string;
}

// 읽기 연산 셋뿐이다 — 통합에 공유된 페이지 목록(search 는 공유분만 돌려준다 — AC1 의
// 구조 근거) · 페이지 본문 블록 · DB 제목(기계 자리 판별).
export interface NotionIngestClient {
  listPages(): Promise<NotionPageStat[]>;
  getPageBlocks(pageId: string): Promise<NotionIngestBlock[]>;
  databaseTitle(databaseId: string): Promise<string>;
}

// ---- 블록 → md 정규화 (AC5 입력 꼴) — 추출 입력으로 충분한 평문 md 를 얻는 보수 변환이다 ----

const HEADING_DEPTH: Record<string, number> = { heading_1: 1, heading_2: 2, heading_3: 3 };

export function notionBlocksToMd(blocks: readonly NotionIngestBlock[]): string {
  const lines: string[] = [];
  for (const block of blocks) {
    const depth = HEADING_DEPTH[block.type];
    if (depth !== undefined) {
      lines.push(`${"#".repeat(depth)} ${block.text}`);
    } else if (block.type === "bulleted_list_item") {
      lines.push(`- ${block.text}`);
    } else if (block.type === "numbered_list_item") {
      lines.push(`1. ${block.text}`);
    } else if (block.type === "to_do") {
      lines.push(`- [${block.checked === true ? "x" : " "}] ${block.text}`);
    } else if (block.type === "quote" || block.type === "callout") {
      lines.push(`> ${block.text}`);
    } else if (block.type === "code") {
      lines.push(`\`\`\`${block.language ?? ""}\n${block.text}\n\`\`\``);
    } else if (block.type === "divider") {
      lines.push("---");
    } else {
      // paragraph 포함 나머지 — 평문 그대로. 모르는 블록도 텍스트가 실렸으면 버리지 않는다.
      lines.push(block.text);
    }
  }
  const text = lines
    .join("\n")
    .split("\n")
    .map((l) => l.replace(/[ \t]+$/, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text === "" ? "" : `${text}\n`;
}

// ---- 증분 수집 (AC2) — 변경 페이지만 본문을 읽고, 기계 DB 페이지는 통째 뺀다 (AC3) ----

/** 노트 경로의 꼴 — API 소스 공통 (sources.ts sourceEntryPath): `<페이지id>/<제목>.md`. */
export function notionPagePath(page: { id: string; title: string }): string {
  return sourceEntryPath(page);
}

export interface NotionPulledPage {
  id: string;
  title: string;
  /** last_edited_time 의 epoch ms — #55 수집 상태의 mtime 자리. */
  mtime: number;
  /** 변경분만 md 가 실린다 — 무변 페이지는 본문 호출 0 (AC2). */
  md: string | null;
}

export interface NotionPull {
  pages: NotionPulledPage[];
}

/**
 * 허브 면의 증분 판정 (AC2) — 목록 1회 + 변경 페이지 수만큼 본문 호출. known 은 플러그인이
 * #55 수집 상태에서 만든 {페이지id → mtime} 이다. 기계 DB(투영 산출 자리) 아래 페이지는
 * 목록 단계에서 **통째 제외**된다 (AC3) — DB 제목 조회는 DB 당 1회 캐시다. 산출은 응답에만
 * 실린다 — 버퍼 밖 저장 0.
 */
export async function pullNotionPages(
  client: NotionIngestClient,
  known: Record<string, number>,
): Promise<NotionPull> {
  const stats = await client.listPages();
  const machineDb = new Map<string, boolean>();
  const pages: NotionPulledPage[] = [];
  for (const stat of stats) {
    if (stat.parent.kind === "database") {
      const dbId = stat.parent.databaseId;
      if (!machineDb.has(dbId)) machineDb.set(dbId, isMachineDbTitle(await client.databaseTitle(dbId)));
      if (machineDb.get(dbId) === true) continue; // 에코 차단 (AC3) — 본문 호출조차 없다
    }
    const mtime = Date.parse(stat.lastEdited);
    if (Number.isNaN(mtime)) throw new NotionIngestError([`페이지 수정 시각이 날짜가 아니다: ${stat.id}`]);
    const changed = known[stat.id] !== mtime;
    pages.push({
      id: stat.id,
      title: stat.title,
      mtime,
      md: changed ? notionBlocksToMd(await client.getPageBlocks(stat.id)) : null,
    });
  }
  return { pages };
}

/** 플러그인 면 — #55 수집 상태에서 known 맵을 만든다 (API 소스 공통 꼴 — sources.ts). */
export function notionKnownStatsOf(state: CollectState, sourceId: string): Record<string, number> {
  return sourceKnownStats(state, sourceId);
}

/**
 * 끌어온 묶음을 #55 경계(SourceReader)로 편다 — collectSource 가 그대로 돌아 디프·메아리
 * 차단·상태 갱신 전부 파일 소스와 같은 꼴이다. 단 하나가 다르다 (AC6): reconcile 은 「목록에서
 * 사라짐 = 삭제」인데, Notion 에서 사라짐은 **공유 해제**다(삭제와 API 로 구별 불가 — 둘 다
 * search 에서 빠진다). 그래서 목록에 없는 기지(旣知) 페이지를 수집 상태의 옛 스탯 **그대로**
 * 유령 항목으로 세운다 — reconcile 에는 무변으로 보여 갱신도 삭제도 없다: 신규 갱신 중단 +
 * 기수집 그래프 잔존. 기계 DB 로 옮겨진 페이지(AC3 제외)도 같은 길로 남는다.
 */
export function notionPulledReader(pull: NotionPull, state: CollectState, sourceId: string): SourceReader {
  const byPath = new Map(pull.pages.map((p) => [notionPagePath(p), p]));
  const pulledIds = new Set(pull.pages.map((p) => p.id));
  const prefix = `${sourceId}:/`;
  const ghosts: VaultFileStat[] = [];
  for (const [path, f] of Object.entries(state.files)) {
    if (!path.startsWith(prefix)) continue;
    const rel = path.slice(prefix.length);
    const id = rel.split("/")[0];
    if (id === undefined || id === "" || pulledIds.has(id)) continue;
    ghosts.push({ path: rel, mtime: f.mtime, size: f.size });
  }
  return {
    async list(): Promise<VaultFileStat[]> {
      // size 는 상수 0 — search 목록에 본문 크기가 없어 증분 선별은 mtime 만으로 선다.
      const live = [...byPath.keys()].map((path) => ({ path, mtime: byPath.get(path)?.mtime ?? 0, size: 0 }));
      return [...live, ...ghosts];
    },
    async read(path: string): Promise<string> {
      const page = byPath.get(path);
      if (!page || page.md === null) {
        throw new NotionIngestError([`본문이 실려 오지 않은 페이지다 — known 맵과 수집 상태가 어긋난다: ${path}`]);
      }
      return page.md;
    },
  };
}
