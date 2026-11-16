// Google Drive 수집 어댑터 경계 (ISSUE-61) — 서버 API 직결 수집 (#53 2차). #56·#57 과 같은
// 꼴로 #55 수집 경계(SourceReader)에 꽂힌다 — 이 모듈은 변환·판정만 들고, HTTP 는 허브
// 어댑터(gdrive-http.ts), 자격증명·스코프 규율은 #60 금고가 이미 진다.
//
// 쓰기 일절 비범위 — 합성 출고 비대상(파일 쪽 합성은 동기화 폴더가 커버): 이 경계에는
// 쓰기 연산 자체가 없다 (AC2 의 구조면). drive.readonly 는 Google restricted scope —
// CASA 연례 심사가 영구 돌봄 비용이다 (moayo-hq#279 기록).
import type { CollectState, VaultFileStat } from "./collect.js";
import { sourceEntryPath, sourceKnownStats, type SourceReader } from "./sources.js";
import { GDRIVE_ALLOWED_SCOPES } from "./oauth-scopes.js"; // 잎 — 금고 본체를 번들로 끌고 가지 않는다

export class GDriveError extends Error {
  constructor(readonly problems: string[]) {
    super(`Drive 수집 거부:\n- ${problems.join("\n- ")}`);
    this.name = "GDriveError";
  }
}

// ---- 스코프 핀 · 레이트리밋 · 후퇴 ----

/** 요청 스코프의 전부 — drive.readonly 하나: 쓰기 스코프 0 이 AC2 다 (#60 허용목록과 같은 값). */
export const GDRIVE_INGEST_SCOPES = GDRIVE_ALLOWED_SCOPES;

/** 호출 간격 바닥 — Drive 쿼터는 넉넉하나 규율은 같다 (어댑터 집행). */
export const GDRIVE_MIN_INTERVAL_MS = 200;
/** 429/403(rate) 지수 후퇴 — 바닥 1s, 2배씩, 최대 3회 뒤 재시도성 오류로 던진다 (AC5). */
export const GDRIVE_BACKOFF_BASE_MS = 1000;
export const GDRIVE_BACKOFF_MAX_RETRIES = 3;

// 전송 오류 — reason 은 Google 오류 reason (rate 꼴만 후퇴 대상, 권한 403 은 즉시 실패).
export class GDriveApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly reason?: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "GDriveApiError";
  }
}

/** 후퇴 대상 판정 (AC5) — 429 전부 + 403 중 rate 꼴 reason 만. 권한 403 은 재시도 무의미. */
export function isBackoffTarget(e: unknown): boolean {
  if (!(e instanceof GDriveApiError)) return false;
  if (e.status === 429) return true;
  return e.status === 403 && /rate|quota/i.test(e.reason ?? "");
}

// ---- 클라이언트 경계 — 읽기 연산뿐이다 ----

export interface DriveEntry {
  id: string;
  name: string;
  mimeType: string;
  /** RFC3339 — 파일만 든다 (폴더는 선별에 안 쓴다). */
  modifiedTime?: string;
}

export interface DriveChangesPage {
  /** 이번 페이지의 변경 수 — 내용은 나르지 않는다: 유무 판정이면 족하다 (AC4). */
  changeCount: number;
  nextPageToken?: string;
  newStartPageToken?: string;
}

export interface GDriveIngestClient {
  /** 폴더 직속 항목 목록 — 하위 폴더는 코어가 걷는다. */
  listChildren(folderId: string): Promise<DriveEntry[]>;
  /** Google Docs 본문 export — markdown 경유. */
  exportDoc(fileId: string): Promise<string>;
  /** md·txt 파일 직수 (alt=media). */
  downloadText(fileId: string): Promise<string>;
  /** changes API 커서 발급 — 최초 수집의 기준점. */
  getStartPageToken(): Promise<string>;
  /** 커서 이후 변경 페이지 — 계정 단위 유무 판정에 쓴다. */
  listChanges(pageToken: string): Promise<DriveChangesPage>;
}

// ---- 꼴 판별 — 문서만 들어온다 (AC3) ----

const DOC_MIME = "application/vnd.google-apps.document";
const FOLDER_MIME = "application/vnd.google-apps.folder";
const TEXT_MIMES = new Set(["text/markdown", "text/x-markdown", "text/plain"]);
const TEXT_EXT = /\.(md|markdown|txt)$/i;

type EntryKind = "doc" | "text" | "folder" | "skip";

export function driveEntryKind(entry: Pick<DriveEntry, "name" | "mimeType">): EntryKind {
  if (entry.mimeType === FOLDER_MIME) return "folder";
  if (entry.mimeType === DOC_MIME) return "doc";
  if (TEXT_MIMES.has(entry.mimeType) || TEXT_EXT.test(entry.name)) return "text";
  return "skip"; // 이미지·바이너리·숏컷·스프레드시트 — 산출 0, 건수만 (AC3)
}

/** 노트 경로의 꼴 — API 소스 공통: `<파일id>/<이름(확장자 제거)>.md`. */
export function gdriveFilePath(file: { id: string; name: string }): string {
  return sourceEntryPath({ id: file.id, title: file.name.replace(TEXT_EXT, "") });
}

// ---- 증분 수집 (AC4) — 커서(changes 페이지 토큰)가 무변 판정의 싼 문이다 ----

export interface GDrivePulledFile {
  id: string;
  title: string;
  mtime: number;
  /** 변경분만 md 가 실린다 — 무변 파일은 본문 호출 0. */
  md: string | null;
}

export interface GDrivePull {
  /** 다음 known.cursor — changes API 의 start page token. */
  cursor: string;
  /** true 면 커서 이후 계정 변경 0 — 목록·본문 호출 없이 끝났다 (AC4). */
  unchanged: boolean;
  files: GDrivePulledFile[];
  /** 비문서(이미지·바이너리 등) 건수 — 이름·내용은 나르지 않는다 (AC3 · zero-retention 지표 규율). */
  skippedBinaries: number;
}

export interface GDriveKnown {
  cursor: string | null;
  files: Record<string, number>;
}

const MAX_WALK_DEPTH = 20;

/**
 * 허브 면의 증분 판정 — ① 커서가 있으면 changes 유무만 묻는다: 변경 0 이면 그대로 끝 (AC4).
 * ② 변경이 있거나 첫 수집이면 폴더 트리를 걷고(닻 폴더 아래만), 스탯(modifiedTime)이 known 과
 * 다른 문서만 본문을 읽는다 — 폴더 소속 판정 비용 때문에 변경 유무는 계정 단위로 묻고,
 * 무엇이 변했는지는 목록 재대조가 가린다(본문 호출은 변경분만이라 폭은 같다).
 */
export async function pullGDriveChanges(
  client: GDriveIngestClient,
  folderId: string,
  known: GDriveKnown,
): Promise<GDrivePull> {
  let cursor: string | null = null;
  if (known.cursor !== null) {
    try {
      let changeCount = 0;
      let token: string | undefined = known.cursor;
      let newStart: string | undefined;
      while (token !== undefined) {
        const page: DriveChangesPage = await client.listChanges(token);
        changeCount += page.changeCount;
        newStart = page.newStartPageToken ?? newStart;
        token = page.nextPageToken;
      }
      cursor = newStart ?? known.cursor;
      if (changeCount === 0) return { cursor, unchanged: true, files: [], skippedBinaries: 0 };
    } catch (e) {
      // 커서 만료 (#441) — changes 페이지 토큰은 영원하지 않다: Google 이 410 으로 버린 커서는
      // 영원히 실패라, 그대로 던지면 이 소스의 증분이 영구 불능이다. 첫 수집 꼴로 접는다 —
      // 새 기준점을 받고 전체를 걷되, 본문 호출은 known.files 스탯 대조가 변경분으로 좁힌다.
      if (!(e instanceof GDriveApiError) || e.status !== 410) throw e;
    }
  }
  if (cursor === null) {
    cursor = await client.getStartPageToken(); // 목록보다 먼저 — 걷는 동안의 변경은 다음 수집이 줍는다
  }

  const files: GDrivePulledFile[] = [];
  let skippedBinaries = 0;
  const stack: { id: string; depth: number }[] = [{ id: folderId, depth: 0 }];
  while (stack.length > 0) {
    const folder = stack.pop() as { id: string; depth: number };
    for (const entry of await client.listChildren(folder.id)) {
      const kind = driveEntryKind(entry);
      if (kind === "folder") {
        if (folder.depth + 1 <= MAX_WALK_DEPTH) stack.push({ id: entry.id, depth: folder.depth + 1 });
        continue;
      }
      if (kind === "skip") {
        skippedBinaries += 1;
        continue;
      }
      const mtime = Date.parse(entry.modifiedTime ?? "");
      if (Number.isNaN(mtime)) throw new GDriveError([`파일 수정 시각이 날짜가 아니다: ${entry.id}`]);
      const changed = known.files[entry.id] !== mtime;
      files.push({
        id: entry.id,
        title: entry.name.replace(TEXT_EXT, ""),
        mtime,
        md: !changed ? null : kind === "doc" ? await client.exportDoc(entry.id) : await client.downloadText(entry.id),
      });
    }
  }
  return { cursor, unchanged: false, files, skippedBinaries };
}

/** 플러그인 면 — #55 수집 상태에서 known 을 만든다 (커서는 CollectState.cursor 자리). */
export function gdriveKnownOf(state: CollectState, sourceId: string): GDriveKnown {
  const cursor = state.cursor;
  return { cursor: typeof cursor === "string" ? cursor : null, files: sourceKnownStats(state, sourceId) };
}

/** 끌어온 묶음을 #55 경계로 편다 — 무변 묶음은 명시 거부 (빈 목록 = 전체 삭제 오판 방지). */
export function gdrivePulledReader(pull: GDrivePull): SourceReader {
  if (pull.unchanged) {
    throw new GDriveError(["무변 묶음이다 — 수집을 건너뛴다 (reconcile 에 들이밀면 전체 삭제로 오판한다)"]);
  }
  const byPath = new Map(pull.files.map((f) => [gdriveFilePath({ id: f.id, name: f.title }), f]));
  return {
    async list(): Promise<VaultFileStat[]> {
      return [...byPath.keys()].map((path) => ({ path, mtime: byPath.get(path)?.mtime ?? 0, size: 0 }));
    },
    async read(path: string): Promise<string> {
      const file = byPath.get(path);
      if (!file || file.md === null) {
        throw new GDriveError([`본문이 실려 오지 않은 파일이다 — known 과 수집 상태가 어긋난다: ${path}`]);
      }
      return file.md;
    },
  };
}
