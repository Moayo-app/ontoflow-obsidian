// Dropbox 수집 어댑터 경계 (ISSUE-62) — 서버 API 직결 수집 (#53 2차), #61 Drive 와 같은 꼴.
// 이 어댑터의 효용은 데스크톱 동기화 앱 없이 쓰는 사용자다 — 동기화 폴더 사용자는 #55 가
// 이미 커버한다. 쓰기 일절 비범위 — 이 경계에는 쓰기 연산 자체가 없다 (AC2 의 구조면).
// HTTP 는 허브 어댑터(dropbox-http.ts), 자격증명·스코프 규율은 #60 금고가 진다.
import type { CollectState, VaultFileStat } from "./collect.js";
import { sourceEntryPath, sourceKnownStats, type SourceReader } from "./sources.js";
import { DROPBOX_ALLOWED_SCOPES } from "./oauth-scopes.js"; // 잎 — 금고 본체를 번들로 끌고 가지 않는다

export class DropboxError extends Error {
  constructor(readonly problems: string[]) {
    super(`Dropbox 수집 거부:\n- ${problems.join("\n- ")}`);
    this.name = "DropboxError";
  }
}

// ---- 스코프 핀 · 레이트리밋 · 후퇴 ----

/** 요청 스코프의 전부 — 읽기 둘(목록은 metadata.read 가 필요하다): 쓰기 스코프 0 이 AC2 다. */
export const DROPBOX_INGEST_SCOPES = DROPBOX_ALLOWED_SCOPES;

/** 호출 간격 바닥 — 규율은 다른 어댑터와 같다 (어댑터 집행). */
export const DROPBOX_MIN_INTERVAL_MS = 200;
/** 429 후퇴 — Retry-After 준수가 우선, 없으면 1s·2배, 최대 3회 뒤 그대로 던진다 (AC5). */
export const DROPBOX_BACKOFF_BASE_MS = 1000;
export const DROPBOX_BACKOFF_MAX_RETRIES = 3;

// 전송 오류 — 어댑터가 상태와 retry_after(초→ms)를 실어 던진다 (단절은 status 0).
export class DropboxApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "DropboxApiError";
  }
}

/** 후퇴 대상 판정 (AC5) — 429 뿐이다: 그 밖은 재시도 폭주의 입구라 즉시 실패다. */
export function isDropboxBackoffTarget(e: unknown): boolean {
  return e instanceof DropboxApiError && e.status === 429;
}

// ---- 클라이언트 경계 — 읽기 연산뿐이다 ----

export interface DropboxEntry {
  /** ".tag" — file 만 수집 후보다 (folder 는 재귀 목록이 이미 편다, deleted 는 재대조가 가린다). */
  tag: "file" | "folder" | "deleted";
  /** 파일 id ("id:…") — 이름이 바뀌어도 불변이라 노트 경로의 닻이다. file 만 든다. */
  id?: string;
  name: string;
  /** RFC3339 server_modified — file 만 든다. */
  serverModified?: string;
}

export interface DropboxIngestClient {
  /** 닻 폴더의 재귀 전량 목록 — 페이지 소비(has_more)는 어댑터 몫, 커서는 끝 커서다. */
  listFolder(rootPath: string): Promise<{ entries: DropboxEntry[]; cursor: string }>;
  /** 커서 이후 변경 유무 — 건수와 새 커서만 나른다 (AC4 의 싼 문). */
  listFolderContinue(cursor: string): Promise<{ entryCount: number; cursor: string }>;
  /** md·txt 본문 직수. */
  downloadText(fileId: string): Promise<string>;
}

// ---- 꼴 판별 — md·txt 만 들어온다 (AC1·AC3). Paper 문서는 별도 API 라 비범위다 ----

const TEXT_EXT = /\.(md|markdown|txt)$/i;

export function isDropboxDocument(entry: DropboxEntry): boolean {
  return entry.tag === "file" && TEXT_EXT.test(entry.name);
}

/** 노트 경로의 꼴 — API 소스 공통: `<파일id>/<이름(확장자 제거)>.md`. */
export function dropboxFilePath(file: { id: string; name: string }): string {
  return sourceEntryPath({ id: file.id, title: file.name.replace(TEXT_EXT, "") });
}

// ---- 커서 증분 (AC4) ----

export interface DropboxPulledFile {
  id: string;
  title: string;
  mtime: number;
  /** 변경분만 md 가 실린다 — 무변 파일은 본문 호출 0. */
  md: string | null;
}

export interface DropboxPull {
  /** 다음 known.cursor — list_folder 의 끝 커서. */
  cursor: string;
  /** true 면 커서 이후 변경 0 — continue 1호출로 끝났다 (AC4). */
  unchanged: boolean;
  files: DropboxPulledFile[];
  /** 비문서 건수 — 이름·내용은 나르지 않는다 (AC3 · zero-retention 지표 규율). */
  skippedBinaries: number;
}

export interface DropboxKnown {
  cursor: string | null;
  files: Record<string, number>;
}

/**
 * 허브 면의 증분 판정 — ① 커서가 있으면 continue 로 변경 유무만 묻는다: 0 이면 그대로 끝
 * (AC4). ② 변경이 있거나 첫 수집이면 전량 재목록 — continue 의 델타는 삭제·이동을 따로
 * 나르는 꼴이라, #55 재대조(목록 부재 = 삭제)의 한 꼴로 통일하는 쪽이 싸고 균일하다.
 * 본문 호출은 스탯(server_modified) 선별로 변경분만이라 폭은 같다.
 */
export async function pullDropboxChanges(
  client: DropboxIngestClient,
  rootPath: string,
  known: DropboxKnown,
): Promise<DropboxPull> {
  if (known.cursor !== null) {
    const delta = await client.listFolderContinue(known.cursor);
    if (delta.entryCount === 0) return { cursor: delta.cursor, unchanged: true, files: [], skippedBinaries: 0 };
  }
  const listed = await client.listFolder(rootPath);
  const files: DropboxPulledFile[] = [];
  let skippedBinaries = 0;
  for (const entry of listed.entries) {
    if (entry.tag !== "file") continue; // folder 는 재귀 목록이 이미 폈고, deleted 는 부재가 가린다
    if (!isDropboxDocument(entry)) {
      skippedBinaries += 1;
      continue;
    }
    if (typeof entry.id !== "string" || entry.id === "") {
      throw new DropboxError([`파일 id 가 없다: 목록 응답이 어긋난다`]);
    }
    const mtime = Date.parse(entry.serverModified ?? "");
    if (Number.isNaN(mtime)) throw new DropboxError([`파일 수정 시각이 날짜가 아니다: ${entry.id}`]);
    const changed = known.files[entry.id] !== mtime;
    files.push({
      id: entry.id,
      title: entry.name.replace(TEXT_EXT, ""),
      mtime,
      md: changed ? await client.downloadText(entry.id) : null,
    });
  }
  return { cursor: listed.cursor, unchanged: false, files, skippedBinaries };
}

/** 플러그인 면 — #55 수집 상태에서 known 을 만든다 (커서는 CollectState.cursor 자리). */
export function dropboxKnownOf(state: CollectState, sourceId: string): DropboxKnown {
  const cursor = state.cursor;
  return { cursor: typeof cursor === "string" ? cursor : null, files: sourceKnownStats(state, sourceId) };
}

/** 끌어온 묶음을 #55 경계로 편다 — 무변 묶음은 명시 거부 (빈 목록 = 전체 삭제 오판 방지). */
export function dropboxPulledReader(pull: DropboxPull): SourceReader {
  if (pull.unchanged) {
    throw new DropboxError(["무변 묶음이다 — 수집을 건너뛴다 (reconcile 에 들이밀면 전체 삭제로 오판한다)"]);
  }
  const byPath = new Map(pull.files.map((f) => [dropboxFilePath({ id: f.id, name: f.title }), f]));
  return {
    async list(): Promise<VaultFileStat[]> {
      return [...byPath.keys()].map((path) => ({ path, mtime: byPath.get(path)?.mtime ?? 0, size: 0 }));
    },
    async read(path: string): Promise<string> {
      const file = byPath.get(path);
      if (!file || file.md === null) {
        throw new DropboxError([`본문이 실려 오지 않은 파일이다 — known 과 수집 상태가 어긋난다: ${path}`]);
      }
      return file.md;
    },
  };
}
