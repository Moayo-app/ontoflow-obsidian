// 수집 소스 경계 (ISSUE-55) — vault 밖 소스를 기존 수집(collect.ts — 디프·위키링크·메아리 차단)과
// 같은 꼴로 그래프에 올리는 읽기 전용 경계. Tier A(파일 기반 md: 일반 폴더·Logseq·클라우드 동기화
// 폴더 — iCloud 는 API 부재로 이 길 고정)는 외부 상시 표면 +0 이다 (moayo-hq#279). API 수집
// (#56 OneNote · #57 Evernote · #61 Drive · #62 Dropbox)은 이 경계(SourceReader)에 꽂힌다.
//
// 구조 (AC2): 이 모듈은 투영 클라이언트(notion.ts·postgres.ts — 쓰기 전용)와 물리적으로 분리돼
// 서로 import 가 없다 — 수집(읽기)·투영(쓰기)은 별개의 단방향 둘이고, 투영의 되읽기 0 구조 증명
// (스펙 AC27)은 이 경계가 아무리 자라도 침식되지 않는다. 메아리 차단(AC3)은 collect.ts 의
// stripProjection(투영 블록)·isMachineAuthored(합성 문서 — #59)가 소스에도 그대로 선다.
import {
  emptyCollectState,
  reconcile,
  type CollectState,
  type CollectedChange,
  type VaultReader,
} from "./collect.js";
import { sliceAtCodePoint } from "./capture.js";
import { resolveHome, type FileIo } from "./store.js";

export class IngestError extends Error {
  constructor(readonly problems: string[]) {
    super(`수집 소스 거부:\n- ${problems.join("\n- ")}`);
    this.name = "IngestError";
  }
}

// 읽기 연산 둘뿐이다 — 쓰기 연산이 없는 것이 수집 단방향의 구조 증명 (AC2 의 쌍대: 투영은 쓰기만,
// 수집은 읽기만). vault 수집의 VaultReader 와 같은 꼴이라 기존 수집기가 그대로 재사용된다.
export type SourceReader = VaultReader;

// md = 일반 md 폴더·클라우드 동기화 폴더 (동기화는 OS 몫 — 우리는 파일만 본다, 표면 +0).
// logseq = md 폴더 + 내부 폴더(`logseq/` — 설정·백업) 제외 규칙. 본문은 md 그대로 둔다 (AC5).
// bear = macOS 로컬 SQLite 읽기 (#58 — 표면 +0, 리더 조립은 플러그인 bear-io 몫).
export const SOURCE_KINDS = ["md", "logseq", "bear"] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

export interface IngestSource {
  /** 노트 경로 접두(`<id>:/…`)가 된다 — 옵시디언 경로에 `:` 가 금지라 vault 경로와 충돌 0. */
  id: string;
  kind: SourceKind;
  /** 리더를 조립할 자리(로컬 절대 경로 등) — 코어는 운반만 하고 해석은 리더 구현 몫이다. */
  root: string;
}

const ID_SHAPE = /^[a-z0-9][a-z0-9-]{0,63}$/;

// ---- 소스 등록·해제 (AC4) — 연결 사실만이 수집의 근거다: 목록에 없으면 수집 자체가 없다 ----

export function registerSource(list: readonly IngestSource[], source: IngestSource): IngestSource[] {
  const problems: string[] = [];
  if (!ID_SHAPE.test(source.id)) problems.push(`소스 id 는 ${ID_SHAPE} 꼴이어야 한다: "${source.id}"`);
  if (!SOURCE_KINDS.includes(source.kind)) problems.push(`모르는 소스 종류다: "${source.kind}"`);
  if (source.root.trim() === "") problems.push("소스 경로가 비었다");
  if (list.some((s) => s.id === source.id)) problems.push(`이미 등록된 id 다: "${source.id}"`);
  if (problems.length > 0) throw new IngestError(problems);
  return [...list, { id: source.id, kind: source.kind, root: source.root }];
}

export function unregisterSource(list: readonly IngestSource[], id: string): IngestSource[] {
  if (!list.some((s) => s.id === id)) throw new IngestError([`등록되지 않은 소스다: "${id}"`]);
  return list.filter((s) => s.id !== id);
}

// 설정 저장소(플러그인 data.json)에서 읽은 값의 복원 — 꼴이 어긋난 항목은 버린다 (임의 보정 0
// 이 원칙이지만, 설정 파일은 사용자 소유라 손상 한 줄이 플러그인 전체를 멈추게 하지 않는다).
export function parseIngestSources(raw: unknown): IngestSource[] {
  if (!Array.isArray(raw)) return [];
  const out: IngestSource[] = [];
  for (const item of raw) {
    const s = item as Partial<IngestSource>;
    if (
      typeof s?.id === "string" &&
      ID_SHAPE.test(s.id) &&
      typeof s.root === "string" &&
      s.root.trim() !== "" &&
      (SOURCE_KINDS as readonly string[]).includes(s.kind as string) &&
      !out.some((x) => x.id === s.id)
    ) {
      out.push({ id: s.id, kind: s.kind as SourceKind, root: s.root });
    }
  }
  return out;
}

// ---- 소스 수집 — 기존 수집기의 재사용 (AC1·AC5) ----

/** 소스 노트의 정본 경로 — `<id>:/<상대경로>`. 노드 이름(파일명)·src.note 전부 이 경로 기준이다. */
export function sourceNotePath(id: string, rel: string): string {
  return `${id}:/${rel}`;
}

/**
 * #55 수집 상태에서 API 소스의 {항목id → mtime} 맵을 만든다 — 증분 선별(known)의 공통 재료.
 * 경로 꼴 `<소스id>:/<항목id>/….md` 의 첫 마디가 항목 id 다.
 */
export function sourceKnownStats(state: CollectState, sourceId: string): Record<string, number> {
  const prefix = `${sourceId}:/`;
  const known: Record<string, number> = {};
  for (const [path, f] of Object.entries(state.files)) {
    if (!path.startsWith(prefix)) continue;
    const id = path.slice(prefix.length).split("/")[0];
    if (id) known[id] = f.mtime;
  }
  return known;
}

/**
 * API 소스 항목(페이지·노트)의 상대 경로 꼴 — `<항목id>/<제목>.md`: 제목이 노드 이름이 되고,
 * 항목 id 가 충돌을 막는다. OneNote(#56)·Evernote(#57)가 같은 꼴을 쓴다.
 */
export function sourceEntryPath(entry: { id: string; title: string }): string {
  const title = sliceAtCodePoint(entry.title.replace(/[\\/:#^[\]|?*]/g, " ").replace(/\s+/g, " ").trim(), 120);
  return `${entry.id}/${title === "" ? "무제" : title}.md`;
}

// 소스 안 수집 대상 판별 — md 만, 숨김 마디(`.`로 시작 — .obsidian·.trash·.ontoflow·동기화
// 도구 내부) 제외. 클라우드 미수신 자리표(`*.md.icloud`)는 확장자가 md 가 아니라 자연 제외다.
// Logseq 꼴은 내부 폴더(`logseq/`)만 더 뺀다 — journals/·pages/ 의 본문은 md 그대로 수집한다 (AC5).
export function isSourceCollectable(rel: string, kind: SourceKind): boolean {
  if (!rel.endsWith(".md")) return false;
  if (rel.split("/").some((seg) => seg.startsWith("."))) return false;
  return !(kind === "logseq" && rel.startsWith("logseq/"));
}

/**
 * 소스 한 곳의 따라잡기 수집 (AC1) — 경로에 `<id>:/` 접두를 입혀 기존 reconcile 에 그대로 태운다:
 * 디프·위키링크 폴백·메아리 차단·스탯 선별 전부 vault 수집과 같은 꼴이다. 소스는 이벤트가 없어
 * 수집은 언제나 스냅샷 대조다 — 이름변경은 삭제+생성으로 잡힌다 (reconcile 계약 그대로).
 */
export async function collectSource(
  reader: SourceReader,
  source: IngestSource,
  state: CollectState,
): Promise<CollectedChange[]> {
  const prefixed: VaultReader = {
    list: async () =>
      (await reader.list())
        .filter((f) => isSourceCollectable(f.path, source.kind))
        .map((f) => ({ ...f, path: sourceNotePath(source.id, f.path) })),
    read: (path) => reader.read(path.slice(source.id.length + 2)),
  };
  return reconcile(prefixed, state, null);
}

// ---- 소스별 수집 상태의 영속 — 그래프 홈의 sources.json (collect.json 과 같은 규율) ----

export const SOURCES_STATE_FILE = "sources.json";
export const SOURCES_SCHEMA_VERSION = 1;

export interface SourceStates {
  schema: typeof SOURCES_SCHEMA_VERSION;
  sources: Record<string, CollectState>;
}

export function emptySourceStates(): SourceStates {
  return { schema: SOURCES_SCHEMA_VERSION, sources: {} };
}

export async function loadSourceStates(io: FileIo, vaultDir: string): Promise<SourceStates> {
  const home = await resolveHome(io, vaultDir);
  const text = await io.readText(`${home.dir}/${SOURCES_STATE_FILE}`);
  if (text === null) return emptySourceStates();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new IngestError([`${SOURCES_STATE_FILE} 이 JSON 이 아니다: ${(e as Error).message}`]);
  }
  const states = parsed as SourceStates;
  if (states?.schema !== SOURCES_SCHEMA_VERSION || typeof states.sources !== "object" || states.sources === null) {
    throw new IngestError([`${SOURCES_STATE_FILE} 스키마가 맞지 않는다 (기대 ${SOURCES_SCHEMA_VERSION})`]);
  }
  return states;
}

export async function saveSourceStates(io: FileIo, vaultDir: string, states: SourceStates): Promise<void> {
  const { dir } = await resolveHome(io, vaultDir);
  await io.mkdir(dir);
  const path = `${dir}/${SOURCES_STATE_FILE}`;
  const tmp = `${path}.tmp`;
  await io.writeText(tmp, JSON.stringify(states));
  await io.rename(tmp, path);
}

/** 해제의 뒷정리 (AC4) — 상태를 지워 재등록이 백지에서 서게 한다. 없는 id 는 무해한 무연산. */
export async function removeSourceState(io: FileIo, vaultDir: string, id: string): Promise<void> {
  const states = await loadSourceStates(io, vaultDir);
  if (!(id in states.sources)) return;
  delete states.sources[id];
  await saveSourceStates(io, vaultDir, states);
}

/**
 * 등록된 소스 전부의 수집 — 목록이 수집의 분모다 (AC4): 해제된 소스는 여기 안 와서 이후 변경이
 * 영영 수집되지 않는다. 산출은 vault 수집과 같은 CollectedChange[] — 호출자가 같은 파이프라인
 * (applyLocal·sendToHub·보류 큐)에 태운다.
 */
export async function collectRegisteredSources(
  io: FileIo,
  vaultDir: string,
  sources: readonly IngestSource[],
  readerFor: (source: IngestSource) => SourceReader,
): Promise<CollectedChange[]> {
  if (sources.length === 0) return [];
  const states = await loadSourceStates(io, vaultDir);
  const out: CollectedChange[] = [];
  for (const source of sources) {
    const state = states.sources[source.id] ?? emptyCollectState();
    states.sources[source.id] = state;
    out.push(...(await collectSource(readerFor(source), source, state)));
  }
  await saveSourceStates(io, vaultDir, states);
  return out;
}
