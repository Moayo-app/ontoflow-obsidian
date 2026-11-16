// 수집 (F1) — 플러그인 쪽 파이프라인 입구. vault 변경을 감지해 unified diff 를 만들어
// 허브 증분 호출(API1)의 입력 큐를 채운다. 허브 호출·패치 적용은 ISSUE-8 몫이다.
//
// 이 자리의 몫 셋:
// - 자기 메아리 금지(AC19): 파이프라인이 쓴 투영 블록(`written-by: ontoflow`)은 수집 입력에서
//   벗겨 낸다. 비교·디프는 전부 벗겨 낸 본문(수집 입력) 기준이다 — 투영만 바뀐 저장은 디프 0.
// - 위키링크 폴백(설계 결정 ⓓ, AC20): 본문 `[[위키링크]]` 는 엔진을 거치지 않고
//   `related-to`+`fallback`(origin: wikilink) 엣지 후보가 되고, 타이핑 제안이 검토 큐(S2)에 선다.
// - 따라잡기(AC6): 수집 상태(그래프 홈의 collect.json — 기본 `.ontoflow/`, #31 지정 가능)에
//   파일별 스탯 + 수집 입력 본문을 들고,
//   재시작 시 스탯이 어긋난 파일만 다시 읽는다 — 전 파일 재해시 0. 본문을 들고 있는 값으로
//   수정 디프가 선다(디프에는 옛 본문이 필요하다).
import { createPatch } from "diff";
import { FALLBACK_VERB_ID } from "./registry.js";
import { ONTOFLOW_DIR, resolveHome, type EdgeRetract, type EdgeWrite, type FileIo } from "./store.js";

export const COLLECT_STATE_FILE = "collect.json";
export const COLLECT_SCHEMA_VERSION = 1;

export class CollectError extends Error {
  constructor(readonly problems: string[]) {
    super(`수집 실패:\n- ${problems.join("\n- ")}`);
    this.name = "CollectError";
  }
}

export interface VaultFileStat {
  path: string; // vault 상대 경로
  mtime: number;
  size: number;
}

// vault 열람의 최소 표면 — 플러그인은 옵시디언 Vault API 로, 테스트는 메모리로 구현한다.
export interface VaultReader {
  list(): Promise<VaultFileStat[]>;
  read(path: string): Promise<string>;
}

export interface CollectState {
  schema: typeof COLLECT_SCHEMA_VERSION;
  // body = 수집 입력(투영 블록 제거본). 스탯은 따라잡기의 싼 선별 기준(AC6).
  files: Record<string, { mtime: number; size: number; body: string }>;
  /** API 소스의 증분 커서 자리 (#57 Evernote syncState · #61 Drive pageToken). vault 수집은 쓰지 않는다. */
  cursor?: number | string;
}

export interface TypingProposal {
  kind: "typing";
  s: string;
  o: string;
  note: string;
}

// 수집 산출 한 건 — 그대로 증분 호출 입력 큐의 원소다(AC1).
export interface CollectedChange {
  note: string;
  kind: "created" | "modified" | "deleted" | "renamed";
  renamedFrom?: string;
  /** 수집 입력 본문의 unified diff. deleted(철회는 디프가 아니라 retractNote 몫)면 null. */
  diff: string | null;
  wikilinkAdds: EdgeWrite[];
  wikilinkRetracts: EdgeRetract[];
  typingProposals: TypingProposal[];
}

export function emptyCollectState(): CollectState {
  return { schema: COLLECT_SCHEMA_VERSION, files: {} };
}

export async function loadCollectState(io: FileIo, vaultDir: string): Promise<CollectState> {
  const home = await resolveHome(io, vaultDir);
  const path = `${home.dir}/${COLLECT_STATE_FILE}`;
  const text = await io.readText(path);
  if (text === null) return emptyCollectState();
  // 손상 자가 복구 (#441) — 깨진 상태 파일이 throw 로 남으면 **매 주기 같은 Notice** 가 서고
  // 수집이 영구 정지한다(복구 커맨드도 없었다). 원본은 지우지 않고 `.corrupt` 로 밀어 둔 뒤
  // (조용한 삭제 0 — vault 안에 실물이 남는다) 빈 상태로 새로 시작한다: 비용은 전량 재대조
  // 1회이고, 같은 달 재추출 과금은 무소비 장부(#193 유지권)가 막는다.
  const recover = async (): Promise<CollectState> => {
    await io.rename(path, `${path}.corrupt`);
    return emptyCollectState();
  };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return recover();
  }
  const state = parsed as CollectState;
  if (state?.schema !== COLLECT_SCHEMA_VERSION || typeof state.files !== "object" || state.files === null) {
    return recover();
  }
  return state;
}

export async function saveCollectState(io: FileIo, vaultDir: string, state: CollectState): Promise<void> {
  const { dir } = await resolveHome(io, vaultDir);
  await io.mkdir(dir);
  const path = `${dir}/${COLLECT_STATE_FILE}`;
  const tmp = `${path}.tmp`;
  await io.writeText(tmp, JSON.stringify(state));
  await io.rename(tmp, path);
}

// 수집 대상 판별 (AC5) — 그래프 홈은 정본·상태의 자리지 입력이 아니고, 노트는 마크다운뿐이다.
// excluded = 수집에서 빼는 루트들의 vault 상대 경로 — 지정 홈(resolveHome().rel — 이슈 #31 AC5)
// 하나였다가 #55 에서 목록으로 일반화됐다(합성 자리(#59)가 다음 자리다). `.ontoflow/` 는 홈이
// 어디든 포인터의 자리라 언제나 제외다.
export function isCollectable(path: string, excluded?: string | readonly string[] | null): boolean {
  if (!path.endsWith(".md")) return false;
  if (path.startsWith(`${ONTOFLOW_DIR}/`) || path.includes(`/${ONTOFLOW_DIR}/`)) return false;
  const roots = typeof excluded === "string" ? [excluded] : (excluded ?? []);
  return !roots.some((r) => r !== "" && path.startsWith(`${r}/`));
}

function noteName(path: string): string {
  const base = path.split("/").pop() ?? path;
  return base.replace(/\.md$/, "");
}

// 투영 블록 제거 (AC19) — frontmatter 최상위 `ontoflow:` 블록 중 `written-by: ontoflow` 마커가
// 있는 것만 벗긴다. 사용자가 직접 쓴 `ontoflow:` 키(마커 없음)는 사용자 입력이므로 남긴다.
export function stripProjection(content: string): string {
  const m = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(content);
  if (!m) return content;
  const lines = (m[1] ?? "").split("\n");
  const start = lines.findIndex((l) => /^ontoflow:/.test(l));
  if (start === -1) return content;
  let end = start + 1;
  while (end < lines.length && /^[ \t]/.test(lines[end] ?? "")) end++;
  if (!lines.slice(start, end).join("\n").includes("written-by: ontoflow")) return content;
  const rest = [...lines.slice(0, start), ...lines.slice(end)];
  const body = content.slice(m[0].length);
  if (rest.every((l) => l.trim() === "")) return body;
  return `---\n${rest.join("\n")}\n---\n${body}`;
}

// 기계 저작 문서 판별 (AC3 일반화 — #55 · #53 「메아리 차단 규칙의 소스별 꼴」) — frontmatter
// 최상위(비들여쓰기) `written-by: ontoflow` 는 문서 전체가 파이프라인 산출(그래프→정본 노트 합성,
// #59)이라는 마커다: 블록이 아니라 문서가 기계 소유물이므로 수집 산출 0 이어야 자기 메아리가 없다.
// 투영 블록의 마커(`ontoflow:` 블록 안, 들여쓰기)와 자리가 달라 충돌하지 않는다 — 그쪽은
// stripProjection 이 블록만 벗기고 사용자 본문은 수집한다. 파일 자리 합성(vault·클라우드 동기화
// 폴더)과 API 목적지 합성(OneNote·Evernote — 집행은 #56·#57 몫)이 전부 이 꼴을 쓴다.
export function isMachineAuthored(content: string): boolean {
  const m = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(content);
  if (!m) return false;
  return (m[1] ?? "").split("\n").some((l) => /^written-by:\s*ontoflow\s*$/.test(l));
}

// 본문 위키링크 수집 (설계 결정 ⓓ) — 코드 펜스 안은 서술이 아니고, 임베드(`![[…]]`)는
// 참조가 아니라 포함이라 후보에서 뺀다. `|별칭`·`#머리글` 은 대상명만 남긴다.
export function extractWikilinks(body: string): string[] {
  const out = new Set<string>();
  let inFence = false;
  for (const line of body.split("\n")) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    for (const match of line.matchAll(/(!?)\[\[([^\]]+)\]\]/g)) {
      if (match[1] === "!") continue;
      const target = (match[2] ?? "").split("|")[0]?.split("#")[0]?.trim();
      if (target) out.add(target);
    }
  }
  return [...out];
}

function wikilinkEdge(s: string, o: string, note: string): EdgeWrite {
  return {
    s,
    v: FALLBACK_VERB_ID,
    o,
    confidence: 1, // 사용자가 명시로 적은 링크다 — 불확실한 건 관계의 종류뿐이고, 그건 fallback 이 든다
    fallback: true,
    by: "auto",
    src: { note, origin: "wikilink" },
  };
}

function linkDelta(
  name: string,
  note: string,
  oldLinks: string[],
  newLinks: string[],
): Pick<CollectedChange, "wikilinkAdds" | "wikilinkRetracts" | "typingProposals"> {
  const oldSet = new Set(oldLinks);
  const newSet = new Set(newLinks);
  const adds = [...newSet].filter((o) => !oldSet.has(o) && o !== name).map((o) => wikilinkEdge(name, o, note));
  const retracts: EdgeRetract[] = [...oldSet]
    .filter((o) => !newSet.has(o))
    .map((o) => ({ s: name, v: FALLBACK_VERB_ID, o, note }));
  return {
    wikilinkAdds: adds,
    wikilinkRetracts: retracts,
    typingProposals: adds.map((e) => ({ kind: "typing", s: e.s, o: e.o, note })),
  };
}

/**
 * 생성·수정 수집. 수집 입력이 그대로면(투영만 바뀐 저장 포함) null — 디프 0 · 허브 호출 0
 * (AC2·AC3). 스탯은 null 이어도 갱신해 둔다 — 따라잡기의 선별이 다시 읽지 않게.
 */
export function collectWrite(
  state: CollectState,
  path: string,
  content: string,
  stat: { mtime: number; size: number },
  excluded?: string | readonly string[] | null,
): CollectedChange | null {
  if (!isCollectable(path, excluded)) return null;
  // 기계 저작 문서(합성 산출)는 수집 대상 밖이다 (AC3). 추적 중이었다면(사용자 노트가 마커를
  // 얻은 드문 경우 — 마커째 복제 등) 추적과 엣지를 끊는다: 산출은 삭제 한 건뿐, 본문은 0.
  if (isMachineAuthored(content)) return collectDelete(state, path);
  const body = stripProjection(content);
  const prev = state.files[path];
  state.files[path] = { mtime: stat.mtime, size: stat.size, body };
  if (prev && prev.body === body) return null;
  const name = noteName(path);
  return {
    note: path,
    kind: prev ? "modified" : "created",
    diff: createPatch(path, prev?.body ?? "", body),
    ...linkDelta(name, path, prev ? extractWikilinks(prev.body) : [], extractWikilinks(body)),
  };
}

/** 삭제 수집 — 엣지 철회는 디프가 아니라 정본의 retractNote(AC12 규칙) 몫이라 디프 없이 알린다. */
export function collectDelete(state: CollectState, path: string): CollectedChange | null {
  if (!state.files[path]) return null;
  delete state.files[path];
  return { note: path, kind: "deleted", diff: null, wikilinkAdds: [], wikilinkRetracts: [], typingProposals: [] };
}

/**
 * 이름변경 수집. 노드 이름·출처 경로가 함께 바뀌므로 옛 이름의 위키링크 엣지는 전부 철회하고
 * 새 이름으로 다시 올린다. 타이핑 제안은 정말 새 링크에만 — 이름만 바뀐 링크로 S2 를 채우지 않는다.
 */
export function collectRename(
  state: CollectState,
  from: string,
  to: string,
  content: string,
  stat: { mtime: number; size: number },
  excluded?: string | readonly string[] | null,
): CollectedChange | null {
  const prev = state.files[from];
  if (prev) delete state.files[from];
  if (!isCollectable(to, excluded) || isMachineAuthored(content)) {
    // 수집 대상 밖으로 나갔다(경로 제외 또는 기계 저작 마커 — AC3) — 추적만 끊는다.
    // 대상이던 적도 없으면 알릴 것도 없다.
    return prev
      ? { note: from, kind: "deleted", diff: null, wikilinkAdds: [], wikilinkRetracts: [], typingProposals: [] }
      : null;
  }
  if (!prev) return collectWrite(state, to, content, stat, excluded);
  const body = stripProjection(content);
  state.files[to] = { mtime: stat.mtime, size: stat.size, body };
  const oldLinks = extractWikilinks(prev.body);
  const newLinks = extractWikilinks(body);
  const newName = noteName(to);
  const genuinelyNew = new Set(newLinks.filter((o) => !oldLinks.includes(o)));
  const adds = newLinks.filter((o) => o !== newName).map((o) => wikilinkEdge(newName, o, to));
  return {
    note: to,
    kind: "renamed",
    renamedFrom: from,
    diff: prev.body === body ? null : createPatch(to, prev.body, body),
    wikilinkAdds: adds,
    wikilinkRetracts: oldLinks.map((o) => ({ s: noteName(from), v: FALLBACK_VERB_ID, o, note: from })),
    typingProposals: adds
      .filter((e) => genuinelyNew.has(e.o))
      .map((e) => ({ kind: "typing" as const, s: e.s, o: e.o, note: to })),
  };
}

/**
 * 따라잡기 (AC6) — 플러그인 꺼진 동안의 변경을 스냅샷 대조로 줍는다. 스탯(mtime·size)이
 * 그대로인 파일은 읽지 않는다 — 대조 비용은 변경 파일 수에 비례한다. 꺼진 동안의 이름변경은
 * 구분할 단서가 없어 삭제+생성으로 잡힌다.
 */
export async function reconcile(
  reader: VaultReader,
  state: CollectState,
  excluded?: string | readonly string[] | null,
): Promise<CollectedChange[]> {
  const listed = (await reader.list()).filter((f) => isCollectable(f.path, excluded));
  const seen = new Set<string>();
  const changes: CollectedChange[] = [];
  for (const f of listed) {
    seen.add(f.path);
    const prev = state.files[f.path];
    if (prev && prev.mtime === f.mtime && prev.size === f.size) continue;
    const change = collectWrite(state, f.path, await reader.read(f.path), f, excluded);
    if (change) changes.push(change);
  }
  for (const path of Object.keys(state.files)) {
    if (seen.has(path)) continue;
    const change = collectDelete(state, path);
    if (change) changes.push(change);
  }
  return changes;
}

// ---- 오프라인 보류 큐 (이슈 #12 AC5) — 허브가 안 닿을 때 수집 산출이 기다리는 자리.
// 로컬 기능(정본 조회·투영·내보내기)은 허브 의존이 없어 그대로 돌고, 추출만 여기 쌓인다.
// 자리는 그래프 홈 (기본 `.ontoflow/` — 설계 결정 ⓐ, #31 지정 가능) — 홈 이동에 보류분도 함께 간다.

export const HOLD_FILE = "pending-extractions.json";

export interface HoldQueue {
  schema: typeof COLLECT_SCHEMA_VERSION;
  items: CollectedChange[];
}

export function emptyHoldQueue(): HoldQueue {
  return { schema: COLLECT_SCHEMA_VERSION, items: [] };
}

export async function loadHoldQueue(io: FileIo, vaultDir: string): Promise<HoldQueue> {
  const home = await resolveHome(io, vaultDir);
  const text = await io.readText(`${home.dir}/${HOLD_FILE}`);
  if (text === null) return emptyHoldQueue();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new CollectError([`${HOLD_FILE} 이 JSON 이 아니다: ${(e as Error).message}`]);
  }
  const queue = parsed as HoldQueue;
  if (queue?.schema !== COLLECT_SCHEMA_VERSION || !Array.isArray(queue.items)) {
    throw new CollectError([`${HOLD_FILE} 스키마가 맞지 않는다 (기대 ${COLLECT_SCHEMA_VERSION})`]);
  }
  return queue;
}

export async function saveHoldQueue(io: FileIo, vaultDir: string, queue: HoldQueue): Promise<void> {
  const { dir } = await resolveHome(io, vaultDir);
  await io.mkdir(dir);
  const path = `${dir}/${HOLD_FILE}`;
  const tmp = `${path}.tmp`;
  await io.writeText(tmp, JSON.stringify(queue));
  await io.rename(tmp, path);
}

// 순서 보존 적재 — 디프는 저장본끼리의 사슬(v1→v2, v2→v3)이라 앞 것을 지우면 그 구간의
// 관계가 영영 추출되지 않는다. 합치기(coalesce)는 본문 없이 불가능하므로 전부 순서대로 든다.
export function enqueueHold(queue: HoldQueue, change: CollectedChange): HoldQueue {
  return { ...queue, items: [...queue.items, change] };
}

// 허브 복귀 — 보류분을 꺼내고 큐를 비운다. 호출 측이 증분 호출(API1)로 잇는다.
export function drainHold(queue: HoldQueue): { queue: HoldQueue; items: CollectedChange[] } {
  return { queue: { ...queue, items: [] }, items: queue.items };
}
