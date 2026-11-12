// Bear 로컬 수집 (ISSUE-58) — Tier C: 클라우드 API 가 없어 macOS 로컬 SQLite 읽기뿐이다.
// 허브 표면 +0 — 전부 플러그인 쪽 로컬 경로고, 이 모듈은 판정·변환만 든다 (파일 접근·macOS
// 게이트는 플러그인 bear-io 몫). 제1 규율: Bear DB 에는 결코 쓰지 않는다 — sql.js 는 바이트의
// 메모리 사본을 열므로(openSqlDatabase) 원본에 닿는 쓰기 경로가 구조적으로 없고, 이 모듈의
// SQL 은 SELECT 뿐이다 (AC2).
import type { Database } from "sql.js";
import { sourceEntryPath, type SourceReader } from "./sources.js";
import type { VaultFileStat } from "./collect.js";

export class BearError extends Error {
  constructor(readonly problems: string[]) {
    super(`Bear 수집 거부:\n- ${problems.join("\n- ")}`);
    this.name = "BearError";
  }
}

/** Bear DB 의 자리 — 홈 디렉터리 상대 (macOS 고정 경로, 플러그인이 홈을 붙인다). */
export const BEAR_DB_RELATIVE_PATH =
  "Library/Group Containers/9K33E3U3T4.net.shinyfrog.bear/Application Data/database.sqlite";

// Core Data 타임스탬프(2001-01-01 기준 초) → epoch ms.
const CORE_DATA_EPOCH_MS = Date.UTC(2001, 0, 1);
export function coreDataToEpochMs(seconds: number): number {
  return Math.round(CORE_DATA_EPOCH_MS + seconds * 1000);
}

export interface BearNote {
  id: string;
  title: string;
  mtime: number;
  md: string;
}

export interface BearNotes {
  notes: BearNote[];
  /** 암호화 노트 건수 — 몰래 복호 시도 없이 건수만 기록한다 (AC3 · zero-retention 지표 규율). */
  encryptedSkipped: number;
}

// Bear 마크업 → md 호환 정규화 — 본문은 이미 마크다운이라 보수 변환만:
// 하이라이트(::…::)는 옵시디언 꼴(==…==)로, 그 밖은 그대로 둔다.
export function bearTextToMd(text: string): string {
  return text
    .replace(/::([^:\n][\s\S]*?)::/g, "==$1==")
    .split("\n")
    .map((l) => l.replace(/[ \t]+$/, ""))
    .join("\n");
}

/**
 * Bear DB 에서 수집 후보를 뜬다 — 휴지통(ZTRASHED)은 제외, 암호화(ZENCRYPTED)는 건수만
 * (AC3: 수집 0 + 몰래 복호 시도 없음). 조회는 SELECT 하나뿐이다 (AC2).
 */
export function readBearNotes(db: Database): BearNotes {
  const notes: BearNote[] = [];
  let encryptedSkipped = 0;
  const stmt = db.prepare(
    `SELECT ZUNIQUEIDENTIFIER AS id, ZTITLE AS title, ZTEXT AS text,
            ZMODIFICATIONDATE AS modified, ZENCRYPTED AS encrypted
     FROM ZSFNOTE
     WHERE ZTRASHED = 0
     ORDER BY ZUNIQUEIDENTIFIER`,
  );
  try {
    while (stmt.step()) {
      const row = stmt.getAsObject() as Record<string, unknown>;
      if (typeof row.id !== "string" || row.id === "") continue;
      if (row.encrypted === 1) {
        encryptedSkipped += 1;
        continue;
      }
      const modified = typeof row.modified === "number" ? coreDataToEpochMs(row.modified) : Number.NaN;
      if (Number.isNaN(modified)) throw new BearError([`노트 수정 시각이 수가 아니다: ${row.id}`]);
      notes.push({
        id: row.id,
        title: typeof row.title === "string" ? row.title : "",
        mtime: modified,
        md: bearTextToMd(typeof row.text === "string" ? row.text : ""),
      });
    }
  } finally {
    stmt.free();
  }
  return { notes, encryptedSkipped };
}

/** 노트 경로의 꼴 — API 소스 공통: `<노트id>/<제목>.md`. */
export function bearNotePath(note: { id: string; title: string }): string {
  return sourceEntryPath({ id: note.id, title: note.title });
}

/**
 * #55 경계(SourceReader)로 편다 — 본문이 이미 메모리에 있어 read 는 공짜고, 증분(AC5)은
 * collectSource 의 스탯 선별(mtime)이 그대로 진다: 무변 노트는 디프 0·산출 0.
 */
export function bearSourceReader(bear: BearNotes): SourceReader {
  const byPath = new Map(bear.notes.map((n) => [bearNotePath(n), n]));
  return {
    async list(): Promise<VaultFileStat[]> {
      return [...byPath.keys()].map((path) => ({ path, mtime: byPath.get(path)?.mtime ?? 0, size: 0 }));
    },
    async read(path: string): Promise<string> {
      const note = byPath.get(path);
      if (!note) throw new BearError([`없는 노트다: ${path}`]);
      return note.md;
    },
  };
}
