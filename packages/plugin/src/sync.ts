// 수집 배선 (F1) — 옵시디언 vault 이벤트 → 코어 수집 → 허브 왕복 → 정본 반영 (AC1).
// 합성(#59) 트리거도 여기 산다 — 수집 완료 → 소스 단위 합성 갱신.
// 허브가 안 닿으면 추출 몫만 보류 큐에 쌓인다 — 철회·위키링크 폴백·타이핑 제안은 로컬 즉시다 (#12 AC5).
import type { Extractor, HubClient } from "./hub-client.js";
import type { ByoEndpoint } from "./settings.js";
import { loadRegistryFile, saveRegistryFile } from "./registry-io.js";
import {
  captureToInbox,
  saveResurfaceState,
  renderResurfaceReport,
  loadResurfaceState,
  isReportDue,
  findGaps,
  findContradictions,
  enqueueInferences,
  deltaSince,
  RESURFACE_NOTE_ID,
  OnboardingError,
  abortInitialIndex,
  applyPatch,
  collectDelete,
  collectRename,
  collectWrite,
  drainHold,
  enqueueHold,
  enqueueMerges,
  enqueueTypings,
  loadCollectState,
  loadDictionary,
  loadHoldQueue,
  loadOnboarding,
  dumpCanonical,
  loadReviewQueue,
  loadSynthesisState,
  restoreCanonical,
  observeVerbs,
  openAiCompatEngine,
  processIncremental,
  processReindex,
  saveSynthesisState,
  synthesisInputFor,
  writeSynthesisNote,
  collectProjectionEdits,
  parseProjection,
  projectionDataFor,
  rebuild,
  reconcile,
  recordAliases,
  recordIndexProgress,
  resolveHome,
  retractNote,
  saveCollectState,
  saveHoldQueue,
  saveOnboarding,
  saveReviewQueue,
  startInitialIndex,
  type CollectedChange,
  type ContextEdge,
  type Engine,
  type EngineFetchLike,
  type FileIo,
  type GraphStore,
  type HeldNote,
  type MergeProposal,
  type NormalizationDictionary,
  type PatchResult,
  type Registry,
  type ReindexNote,
  type VaultReader,
} from "./core.js";

export type VaultEvent =
  | { kind: "write"; path: string; content: string; stat: { mtime: number; size: number } }
  | { kind: "rename"; from: string; to: string; content: string; stat: { mtime: number; size: number } }
  | { kind: "delete"; path: string };

// 수집 제외 루트 — 지정 홈(#31)과 합성 자리(#59): 합성 자리 제외가 메아리 차단의 자리 축이고,
// 마커(#55 isMachineAuthored)가 내용 축이다 — 이중 방어.
async function excludedRoots(io: FileIo, vaultDir: string): Promise<string[]> {
  const home = await resolveHome(io, vaultDir);
  const synthesis = await loadSynthesisState(io, vaultDir);
  return [synthesis.dir, ...(home.rel !== null && home.rel !== "" ? [home.rel] : [])];
}

// 이벤트 묶음을 순서대로 수집 상태에 통과시킨다 (#439 ②) — 상태 적재·저장이 묶음당 1회라
// 저장 폭풍(자동 저장)에서 collect.json 재직렬화가 이벤트 수만큼 돌지 않는다. 산출 없는
// 이벤트(무변·비대상)는 결과에서 빠진다.
// ⚠️ 호출 전 가드가 계약이다 (#439 ①): 처리가 설 수 없는 자리(store 준비 전)에서 부르면
// 상태가 「이미 본 것」으로 박혀 재시작 reconcile 로도 되줍지 못한다 — 그때는 부르지 말고
// 이벤트를 대기열에 둬라(상태 미기록이면 다음 따라잡기가 같은 변경을 다시 줍는다).
export async function collectEvents(
  io: FileIo,
  vaultDir: string,
  events: readonly VaultEvent[],
): Promise<CollectedChange[]> {
  if (events.length === 0) return [];
  const excluded = await excludedRoots(io, vaultDir);
  const state = await loadCollectState(io, vaultDir);
  const changes: CollectedChange[] = [];
  for (const event of events) {
    const change =
      event.kind === "write"
        ? collectWrite(state, event.path, event.content, event.stat, excluded)
        : event.kind === "rename"
          ? collectRename(state, event.from, event.to, event.content, event.stat, excluded)
          : collectDelete(state, event.path);
    if (change !== null) changes.push(change);
  }
  await saveCollectState(io, vaultDir, state);
  return changes;
}

// 이벤트 하나 — 묶음의 특수형. 산출이 없으면(무변·비대상) null 이다.
export async function collectEvent(
  io: FileIo,
  vaultDir: string,
  event: VaultEvent,
): Promise<CollectedChange | null> {
  return (await collectEvents(io, vaultDir, [event]))[0] ?? null;
}

// ---- 이벤트 디바운스 (#439 ②) — 판정은 순수, 타이머 배선은 main 몫 ----

/** 조용 창 — 마지막 이벤트 뒤 이만큼 조용하면 묶음을 민다 (자동 저장 간격보다 길게). */
export const EVENT_QUIET_MS = 3_000;
/** 최대 대기 — 연속 저장(타이핑 중 자동 저장)이 조용 창을 영원히 미루지 못하게 하는 상한. */
export const EVENT_MAX_WAIT_MS = 30_000;

/** 다음 플러시까지의 지연 — 조용 창과 「첫 적체로부터의 상한」 중 먼저 오는 쪽이다. */
export function nextFlushDelay(firstQueuedAt: number, now: number): number {
  return Math.max(0, Math.min(EVENT_QUIET_MS, firstQueuedAt + EVENT_MAX_WAIT_MS - now));
}

/**
 * 묶음에서 승격 관찰(ObservedNote)을 뽑는다 — 경로별 마지막 원문만 남긴다: 같은 노트의
 * 중간 저장본은 승격 판정(블록 디프)에 의미가 없고, rename 은 원문을 새 경로로 옮기며,
 * delete 는 관찰을 걷는다(철회는 수집 산출 쪽 몫 — 기존 onEvent 의 「삭제는 관찰 0」 그대로).
 */
export function observedFromEvents(events: readonly VaultEvent[]): ObservedNote[] {
  const latest = new Map<string, string>();
  for (const event of events) {
    if (event.kind === "write") {
      latest.set(event.path, event.content);
    } else if (event.kind === "rename") {
      latest.delete(event.from);
      latest.set(event.to, event.content);
    } else {
      latest.delete(event.path);
    }
  }
  return [...latest.entries()].map(([path, content]) => ({ path, content }));
}

/** 따라잡기에서 다시 읽힌 노트의 현재 원문(투영 블록 포함) — 승격(ISSUE-451)의 입력. */
export interface ObservedNote {
  path: string;
  content: string;
}

export interface CatchUpResult {
  changes: CollectedChange[];
  observed: ObservedNote[];
}

// 따라잡기 — 플러그인이 꺼져 있던 동안의 변경을 스냅샷 대조로 줍는다 (코어 reconcile 의 영속 배선).
// 수집 산출(changes)과 별도로, stat 이 어긋나 다시 읽힌 파일의 **원문**을 observed 로 돌려준다
// (ISSUE-451): 수집 상태의 body 는 투영 제거본이라 블록 편집 판정에 쓸 수 없고, reconcile 은
// 원문을 버린다 — 블록만 고친 노트는 changes 0 으로 끝나 그 편집이 다음 재투영에 되덮인다.
// 선별은 reconcile 의 상태 갱신을 그대로 비춘다(제외 루트·기계 저작 문서·삭제는 상태에 남지
// 않아 자동 탈락) — 재독 비용은 stat 변경 파일 수에 비례, 무변 파일 재독 0 은 무변이다 (AC6).
export async function catchUp(io: FileIo, vaultDir: string, reader: VaultReader): Promise<CatchUpResult> {
  const excluded = await excludedRoots(io, vaultDir);
  const state = await loadCollectState(io, vaultDir);
  const before = new Map(Object.entries(state.files).map(([p, f]) => [p, `${f.mtime}:${f.size}`]));
  const changes = await reconcile(reader, state, excluded);
  const observed: ObservedNote[] = [];
  for (const [path, f] of Object.entries(state.files)) {
    if (before.get(path) === `${f.mtime}:${f.size}`) continue;
    observed.push({ path, content: await reader.read(path) });
  }
  // 저장은 재독 뒤에 — 재독이 중간에 던지면 상태도 안 선다: 다음 시작이 같은 변경을 다시 줍는다.
  await saveCollectState(io, vaultDir, state);
  return { changes, observed };
}

// ---- PG 정본 (#63) — 「보관은 PG, 판정은 작업본」: 정본은 사용자 PG, 로컬 파일(graph.sqlite·
// registry.yml)은 세션 작업 사본이다 — 시작 시 PG 가 덮고(정본 승), 변경 뒤 flush 가 되민다 ----

export interface PgCanonicalHandle {
  store: GraphStore;
  registry: Registry;
  /** 낙관적 잠금 카운터 — flush 가 가드로 걸고 +1 로 돌아온다. */
  rev: number;
}

/** 시작 적재 — PG 덤프로 작업본을 세우고, 등록부 작업 사본(registry.yml)을 갱신한다. */
export async function loadPgCanonical(io: FileIo, vaultDir: string, hub: HubClient): Promise<PgCanonicalHandle> {
  const dump = await hub.canonicalLoad();
  const { store, registry } = await restoreCanonical(io, dump);
  const home = await resolveHome(io, vaultDir);
  store.path = `${home.dir}/graph.sqlite`; // 로컬 사본 자리 — 정본은 PG, 이 파일은 캐시다
  await saveRegistryFile(io, vaultDir, registry); // 등록부 작업 사본 — 정본은 덤프(PG) 쪽 (AC4)
  return { store, registry, rev: dump.rev };
}

/**
 * 변경 반영 — 작업본(그래프 + 등록부 사본)을 덤프로 떠서 PG 에 민다. rev 가드 불일치(409)는
 * 그대로 던진다 — 호출자가 재적재를 안내한다 (AC5: 반쪽 커밋 0, 임의 병합 0).
 */
export async function flushPgCanonical(
  io: FileIo,
  vaultDir: string,
  hub: HubClient,
  store: GraphStore,
  rev: number,
): Promise<number> {
  const registry = await loadRegistryFile(io, vaultDir);
  const { rev: next } = await hub.canonicalFlush(dumpCanonical(store, registry, rev));
  return next;
}

// ---- 합성 트리거 (#59) — 수집 완료 → 소스 단위 합성 갱신 ----

/**
 * 소스 하나의 합성 한 판 (AC1) — `§23` 동의 전이면 시작 0 (AC5: 합성도 추출 처리의 연장,
 * 허브 게이트와 이중 방어). 그래프에서 소스 부분 그래프를 떠서 허브 판정을 받고, 기계
 * 자리에 쓴다 — 쓰기 목적지는 기계 자리의 소스별 고정 경로 하나뿐이다 (AC2).
 */
export async function runSynthesis(
  io: FileIo,
  vaultDir: string,
  store: GraphStore,
  hub: HubClient,
  sourceId: string,
  now: string,
): Promise<{ path: string; title: string; md: string }> {
  const onboarding = await loadOnboarding(io, vaultDir);
  if (onboarding.consent === null) {
    throw new OnboardingError(["`§23` 별도 동의 전이다 — 합성도 추출 처리의 연장이다 (AC5)"]);
  }
  const input = synthesisInputFor(store, sourceId);
  const note = await hub.synthesize(input);
  const state = await loadSynthesisState(io, vaultDir);
  const written = await writeSynthesisNote(io, vaultDir, state, sourceId, note, now);
  await saveSynthesisState(io, vaultDir, written.state);
  // 출고 표면 (ISSUE-372) — 호출자가 API 목적지(synthesizeTo)로 이어 보낼 수 있게 내용도 돌려준다.
  return { path: written.path, title: note.title, md: note.md };
}

// PG 수집함 비우기 (#81 · #439 ③) — 원격 MCP 캡처분이 vault 수집함(md)으로 내려와 다음 수집에
// 합류한다. 2단이다: 받기(peek — 서버는 지우지 않는다) → vault 파일 확정 → 삭제 확인(ack —
// 파일로 선 id 만). 중간 실패·응답 유실 시 캡처는 서버에 남아 다음 드레인이 다시 받는다 —
// 소실 0, 중복 허용(at-least-once: 같은 캡처가 vault 수집함에 두 번 설 수는 있다).
export async function drainPgInbox(
  io: FileIo,
  vaultDir: string,
  hub: HubClient,
  now: string,
): Promise<{ written: string[] }> {
  const { notes } = await hub.canonicalPeekInbox();
  const written: string[] = [];
  const landed: string[] = [];
  try {
    for (const note of notes) {
      const { path } = await captureToInbox(io, vaultDir, { title: note.title, md: note.md }, now);
      written.push(path);
      landed.push(note.id);
    }
  } finally {
    // 파일로 선 것만 확정한다 — 쓰기 루프가 중간에 던져도 선 몫의 삭제는 확정하고 던진다.
    if (landed.length > 0) await hub.canonicalAckInbox(landed);
  }
  return { written };
}

// ---- 재부상 한 판 (#80) — 수집 사이클 편승: 주기가 지났으면(또는 강제) 판정 → 리뷰 큐 적재 →
// 리포트 노트(기계 자리 — #59 의미론 그대로). 판정은 전부 코어 결정론 연산이라 허브 왕복 0 이다.
export interface ResurfaceOutcome {
  /** null = 할 말이 없어 리포트를 만들지 않았다 (AC4). */
  reportPath: string | null;
  queued: number;
}

export async function runResurface(
  io: FileIo,
  vaultDir: string,
  store: GraphStore,
  registry: Registry,
  now: string,
  force: boolean,
): Promise<ResurfaceOutcome | null> {
  const state = await loadResurfaceState(io, vaultDir);
  if (!force && !isReportDue(state, now)) return null;

  const contradictions = findContradictions(store, registry);
  const gaps = findGaps(store);
  const { queue, added } = enqueueInferences(await loadReviewQueue(io, vaultDir), [...contradictions, ...gaps]);
  await saveReviewQueue(io, vaultDir, queue);

  // 리포트에는 판정 대기분만 싣는다 — 사용자가 「유지·확인」 한 발견을 매주 다시 들이밀면
  // 그게 곧 잡음이다 (판정 존중). 미해소 pending 은 다시 실린다 — 리마인드는 재부상의 일이다.
  const pending = new Set(queue.inferences.filter((i) => i.status === "pending").map((i) => i.fingerprint));
  const delta = deltaSince(store, state.lastUlid);
  const md = renderResurfaceReport({
    periodFrom: state.lastReportAt,
    periodTo: now,
    delta,
    contradictions: contradictions.filter((f) => pending.has(f.fingerprint)),
    gaps: gaps.filter((f) => pending.has(f.fingerprint)),
    newlyQueued: added,
  });
  let reportPath: string | null = null;
  if (md !== null) {
    const synthesis = await loadSynthesisState(io, vaultDir);
    const written = await writeSynthesisNote(io, vaultDir, synthesis, RESURFACE_NOTE_ID, { title: "OntoFlow 주간 리포트", md }, now);
    await saveSynthesisState(io, vaultDir, written.state);
    reportPath = written.path;
  }
  await saveResurfaceState(io, vaultDir, {
    ...state,
    lastReportAt: now,
    lastUlid: delta.maxUlid,
  });
  return { reportPath, queued: added };
}

const zeroPatch = (): PatchResult => ({ added: 0, updated: 0, skipped: 0, retracted: 0 });

export interface LocalEffects {
  patch: PatchResult;
  retractedNotes: string[];
  typingsQueued: number;
}

// ---- 투영 편집 승격 (#10 AC18·AC3 — ISSUE-430) ----
// 유일한 양방향 표면의 읽는 쪽 절반: 사용자가 frontmatter `ontoflow:` 블록을 고치면 그 디프가
// by:user 패치로 정본에 승격된다. 수집 산출과 **독립**으로 이벤트 원문에서 돌아야 한다 —
// 블록만 고친 저장은 본문(투영 제거본)이 무변이라 collectWrite 가 null 을 돌려주는데, 바로 그
// 저장이 손실 지점이었다(수집은 블록째 벗기고, 다음 재투영이 정본 값으로 되덮었다).
export async function promoteProjectionEdits(
  store: GraphStore,
  registry: Registry,
  notePath: string,
  content: string,
): Promise<PatchResult | null> {
  let observed: ReturnType<typeof parseProjection>;
  try {
    observed = parseProjection(content);
  } catch {
    return null; // 손상 블록 — 편집 판정 불가: 승격 없이 둔다(재투영이 블록을 되세운다)
  }
  if (observed === null) return null; // 블록 없음 = 아직 투영 전 — 편집이 아니다
  const edits = collectProjectionEdits(notePath, projectionDataFor(store, notePath), observed);
  if (edits.add.length === 0 && edits.retract.length === 0) return null;
  return applyPatch(store, registry, edits);
}

// 허브 없이 끝나는 효과 — 철회·위키링크 폴백 엣지·타이핑 제안. 수집 직후 항상 돈다.
export async function applyLocal(
  io: FileIo,
  vaultDir: string,
  store: GraphStore,
  registry: Registry,
  changes: readonly CollectedChange[],
): Promise<LocalEffects> {
  const retractedNotes: string[] = [];
  for (const c of changes) {
    if (c.kind === "deleted") {
      await retractNote(store, c.note);
      retractedNotes.push(c.note);
    }
  }
  const add = changes.flatMap((c) => c.wikilinkAdds);
  const retract = changes.flatMap((c) => c.wikilinkRetracts);
  const patch =
    add.length + retract.length > 0 ? await applyPatch(store, registry, { add, retract }) : zeroPatch();
  const typings = changes.flatMap((c) => c.typingProposals);
  if (typings.length > 0) {
    const queue = await loadReviewQueue(io, vaultDir);
    await saveReviewQueue(io, vaultDir, enqueueTypings(queue, typings));
  }
  return { patch, retractedNotes, typingsQueued: typings.length };
}

export interface HubDispatch {
  patch: PatchResult;
  held: HeldNote[];
  verbObservations: number;
  /** 정규화 산출 반영분 — 별칭 박제 수·S2 병합 제안 수 (#47). */
  aliasesRecorded: number;
  mergesQueued: number;
  /**
   * 거래 고지 (ISSUE-362 — #193 AC12 의 「API 응답」 채널): 서버가 200 에 실어 보낸
   * usage-80·usage-100 꼴. 호출자(플러그인 main)가 Notice 로 세운다 — 버리면 고지 의무 반쪽이다.
   */
  notices: string[];
}

// 허브 정규화 산출의 정본 반영 — 별칭은 박제, 임계 미만 제안은 S2 로. 별칭이 그새 다른
// 노드에 매였으면(사전 송신 뒤의 사용자 편집) 그 쌍만 버린다 — 사용자 편집 항상 승.
async function applyNormalization(
  io: FileIo,
  vaultDir: string,
  store: GraphStore,
  aliases: readonly { node: string; alias: string }[],
  merges: readonly MergeProposal[],
): Promise<{ aliasesRecorded: number; mergesQueued: number }> {
  let recorded = 0;
  for (const pair of aliases) {
    try {
      await recordAliases(store, [pair]);
      recorded += 1;
    } catch {
      // 충돌 쌍만 건너뛴다 — 나머지 반영은 계속된다
    }
  }
  if (merges.length > 0) {
    const queue = await loadReviewQueue(io, vaultDir);
    await saveReviewQueue(io, vaultDir, enqueueMerges(queue, merges));
  }
  return { aliasesRecorded: recorded, mergesQueued: merges.length };
}

// ---- BYO 추출 (#88) — 추출만 사용자 엔드포인트로: 코어 process*(정규화 포함)를 플러그인이
// 로컬 엔진으로 그대로 돌린다. 허브 왕복 0 이 구조다 — 본문·자격증명이 기기를 떠나지 않는다
// (AC1·AC4). 추출 외 허브 왕복(합성·PG 정본·수집함)은 각자 경로 그대로다 ----

export function byoExtractor(engine: Engine): Extractor {
  return {
    extractIncremental: (call) => processIncremental(engine, call),
    extractReindex: (call) => processReindex(engine, call),
  };
}

// BYO 가 서 있으면 로컬 추출기, 아니면 허브 — 미설정 기본값은 기존 경로 무변이다 (AC3).
export function extractorFor(
  byo: ByoEndpoint | null,
  hub: Extractor,
  fetchFn: EngineFetchLike,
): Extractor {
  if (byo === null) return hub;
  return byoExtractor(openAiCompatEngine({ baseUrl: byo.url, model: byo.model, apiKey: byo.apiKey }, fetchFn));
}

// 본문 디프 → 증분 추출(API1 — 허브 또는 BYO 로컬) → 정본 패치 + 동사 관측 접수. 추출기가 안
// 닿으면 그대로 던진다 — 호출자가 보류 큐로 잇는다. `§23` 동의 전이면 호출 자체가 없다 (AC2 의 이중 방어).
export async function sendToHub(
  io: FileIo,
  vaultDir: string,
  store: GraphStore,
  registry: Registry,
  hub: Extractor,
  changes: readonly CollectedChange[],
): Promise<HubDispatch> {
  const onboarding = await loadOnboarding(io, vaultDir);
  if (onboarding.consent === null) {
    throw new OnboardingError(["`§23` 별도 동의 전이다 — 추출 처리 0 (AC2)"]);
  }
  const diffs = changes
    .filter((c): c is CollectedChange & { diff: string } => c.diff !== null)
    .map((c) => ({ note: c.note, diff: c.diff }));
  if (diffs.length === 0) {
    return { patch: zeroPatch(), held: [], verbObservations: 0, aliasesRecorded: 0, mergesQueued: 0, notices: [] };
  }
  // 문맥 = 이 노트 출처의 기존 엣지 (projectionDataFor 의 모든 엣지는 (s ?? node) -[v]-> to 꼴이다).
  const context: ContextEdge[] = diffs.flatMap(({ note }) => {
    const data = projectionDataFor(store, note);
    return data.edges.map((e) => ({ s: e.s ?? data.node, v: e.v, o: e.to, note }));
  });
  // 별칭 사전 동봉 — 허브 정규화(#47)의 입력: 사전 히트는 판정 호출 0 이다.
  const res = await hub.extractIncremental({
    registry,
    changes: diffs,
    context,
    dictionary: loadDictionary(store),
  });
  const patch =
    res.add.length + res.retract.length > 0
      ? await applyPatch(store, registry, { add: res.add, retract: res.retract })
      : zeroPatch();
  if (res.proposals.length > 0) {
    const queue = await loadReviewQueue(io, vaultDir);
    await saveReviewQueue(io, vaultDir, observeVerbs(queue, res.proposals));
  }
  const normalized = await applyNormalization(io, vaultDir, store, res.aliases, res.merges);
  // 고지 운반 (ISSUE-362) — 응답 타입 밖의 동반 필드다(BYO 로컬 추출은 지갑이 없어 늘 빈 목록).
  const notices = (res as { notices?: unknown }).notices;
  return {
    patch,
    held: res.held,
    verbObservations: res.proposals.length,
    ...normalized,
    notices: Array.isArray(notices) ? notices.filter((n): n is string => typeof n === "string") : [],
  };
}

// ---- 오프라인 보류 (#12 AC5) — 추출 몫만 쌓는다: 로컬 효과는 applyLocal 이 이미 반영했다 ----

export async function holdForLater(
  io: FileIo,
  vaultDir: string,
  changes: readonly CollectedChange[],
): Promise<void> {
  let queue = await loadHoldQueue(io, vaultDir);
  for (const c of changes) queue = enqueueHold(queue, c);
  await saveHoldQueue(io, vaultDir, queue);
}

// 보류분을 비워 돌려준다 — 재시도 실패 시 되돌리는 것(다시 holdForLater)은 호출자 몫이다.
export async function takeHeld(io: FileIo, vaultDir: string): Promise<CollectedChange[]> {
  const { queue, items } = drainHold(await loadHoldQueue(io, vaultDir));
  await saveHoldQueue(io, vaultDir, queue);
  return items;
}

// ---- 최초 색인 (S1 의 끝) — vault 전량 → 재색인 API2 → 정본 원자 교체 (AC10 경로) ----

export interface InitialIndexResult {
  store: GraphStore;
  total: number;
  held: HeldNote[];
}

export async function runInitialIndex(
  io: FileIo,
  vaultDir: string,
  reader: VaultReader,
  registry: Registry,
  hub: Extractor,
  now: string,
  /** 기존 정본의 별칭 사전 — 재색인 정규화의 입력. 새 vault 면 생략한다 (#47). */
  dictionary?: NormalizationDictionary,
): Promise<InitialIndexResult> {
  // AC2 — 동의(와 선행 단계) 전이면 수집 적재조차 시작하지 않는다: 관문을 먼저 지난다.
  // (전이 자체는 노트 수가 확정된 뒤 실제 수로 다시 한다 — 여기서는 관문 판정만 빌린다.)
  startInitialIndex(await loadOnboarding(io, vaultDir), 0);

  // 수집 상태를 전량으로 세운다 — 이후 증분 수집의 기준점. 변경 목록 자체는 버린다:
  // 재색인이 어차피 전량을 본다. catchUp 이 아니라 reconcile 직행이다 — 전량 적재에서
  // 승격 관찰(ISSUE-451)의 원문 재독까지 하면 전 파일을 두 번 읽는다.
  {
    const excluded = await excludedRoots(io, vaultDir);
    const state = await loadCollectState(io, vaultDir);
    await reconcile(reader, state, excluded);
    await saveCollectState(io, vaultDir, state);
  }
  const seeded = await loadCollectState(io, vaultDir);
  const notes: ReindexNote[] = Object.entries(seeded.files).map(([note, f]) => ({ note, body: f.body }));

  let onboarding = startInitialIndex(await loadOnboarding(io, vaultDir), notes.length);
  await saveOnboarding(io, vaultDir, onboarding);

  try {
    const res = await hub.extractReindex({
      registry,
      notes,
      ...(dictionary === undefined ? {} : { dictionary }),
    });
    const store = await rebuild(io, vaultDir, res.versions, async (work) => {
      await applyPatch(work, registry, { add: res.edges, retract: [] });
    });
    if (res.proposals.length > 0) {
      const queue = await loadReviewQueue(io, vaultDir);
      await saveReviewQueue(io, vaultDir, observeVerbs(queue, res.proposals));
    }
    await applyNormalization(io, vaultDir, store, res.aliases, res.merges); // 별칭은 새 정본에 박는다
    // 진행률은 한 호출이라 한 번에 닿는다 — 호출 단위 세분화는 허브 조립(#43) 뒤 몫: 재색인
    // 분할은 「최초 색인 1회」 과금 표식·원자 교체 의미론과 함께 움직여야 해 여기서 하지 않는다.
    onboarding = recordIndexProgress(onboarding, notes.length, now);
    await saveOnboarding(io, vaultDir, onboarding);
    return { store, total: notes.length, held: res.held };
  } catch (e) {
    // 실패 원복 (ISSUE-431) — 시작 표식이 남으면 「색인 시작」 버튼이 영구 비활성(막다른 길):
    // 시작 전으로 되돌리고 던진다 — 사유 Notice 와 재시도는 호출자(온보딩 모달) 몫이다.
    await saveOnboarding(io, vaultDir, abortInitialIndex(await loadOnboarding(io, vaultDir)));
    throw e;
  }
}
