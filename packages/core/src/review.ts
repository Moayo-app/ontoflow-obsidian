// 검토 큐 (S2) — 기계의 제안(커스텀 동사 · 병합 · 타이핑)이 모이는 한 자리. 확정은 전부
// 사람이다 — 자동 수락 경로는 어디에도 없다 (이슈 #12 AC3·AC4 · moayo-hq#271 결의 4).
// 기각은 기록이다: 같은 입력이 재관측돼도 동일 제안은 다시 서지 않는다 (AC6).
// 큐의 자리는 그래프 홈 (기본 `.ontoflow/` — 설계 결정 ⓐ, #31 지정 가능) — 동사 제안의 수명주기는 registry.ts 가
// 정의한 것을 그대로 들고, 병합·타이핑 제안이 같은 규율의 작은 수명주기를 더한다.
import type { TypingProposal } from "./collect.js";
import type { MergeProposal } from "./normalize.js";
import { FALLBACK_VERB_ID, observe, type Observation, type Proposal } from "./registry.js";
import { resolveHome, type FileIo, type Patch } from "./store.js";

export const REVIEW_FILE = "review-queue.json";
export const REVIEW_SCHEMA_VERSION = 1;

export class ReviewError extends Error {
  constructor(readonly problems: string[]) {
    super(`검토 큐 실패:\n- ${problems.join("\n- ")}`);
    this.name = "ReviewError";
  }
}

export type ReviewStatus = "pending" | "accepted" | "rejected";

export interface MergeItem {
  name: string; // 병합될 표기
  node: string; // 귀속 후보 노드
  confidence: number;
  status: ReviewStatus;
}

export interface TypingItem {
  s: string;
  o: string;
  note: string;
  status: ReviewStatus;
}

/** 재부상 판정(#80)의 대기 항목 — 모순은 철회 후보 엣지를 들고, 공백은 확인(기각)만 받는다. */
export interface InferenceItem {
  fingerprint: string;
  kind: "contradiction" | "gap";
  summary: string;
  edges: { s: string; v: string; o: string; note: string | null }[];
  status: ReviewStatus;
}

export interface ReviewQueue {
  schema: typeof REVIEW_SCHEMA_VERSION;
  verbs: Proposal[]; // registry.ts 수명주기(observed/proposed/confirmed/rejected) 그대로
  merges: MergeItem[];
  typings: TypingItem[];
  /** 재부상 판정 대기 (#80) — 구 파일(필드 부재)은 빈 배열로 선다. */
  inferences: InferenceItem[];
}

export function emptyReviewQueue(): ReviewQueue {
  return { schema: REVIEW_SCHEMA_VERSION, verbs: [], merges: [], typings: [], inferences: [] };
}

// ---- 영속 — collect.json 과 같은 규율: 없으면 빈 큐, 손상은 임의 보정 없이 거부 ----

export async function loadReviewQueue(io: FileIo, vaultDir: string): Promise<ReviewQueue> {
  const home = await resolveHome(io, vaultDir);
  const text = await io.readText(`${home.dir}/${REVIEW_FILE}`);
  if (text === null) return emptyReviewQueue();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new ReviewError([`${REVIEW_FILE} 이 JSON 이 아니다: ${(e as Error).message}`]);
  }
  const queue = parsed as ReviewQueue;
  if (
    queue?.schema !== REVIEW_SCHEMA_VERSION ||
    !Array.isArray(queue.verbs) ||
    !Array.isArray(queue.merges) ||
    !Array.isArray(queue.typings) ||
    (queue.inferences !== undefined && !Array.isArray(queue.inferences))
  ) {
    throw new ReviewError([`${REVIEW_FILE} 스키마가 맞지 않는다 (기대 ${REVIEW_SCHEMA_VERSION})`]);
  }
  return { ...queue, inferences: queue.inferences ?? [] }; // #80 이전 파일 호환 — 필드 부재 = 빈 배열
}

export async function saveReviewQueue(io: FileIo, vaultDir: string, queue: ReviewQueue): Promise<void> {
  const { dir } = await resolveHome(io, vaultDir);
  await io.mkdir(dir);
  const path = `${dir}/${REVIEW_FILE}`;
  const tmp = `${path}.tmp`;
  await io.writeText(tmp, JSON.stringify(queue));
  await io.rename(tmp, path);
}

// ---- 적재 — 파이프라인 산출이 큐에 선다. 같은 키의 기존 항목(상태 불문)은 다시 서지 않는다:
// pending 은 중복, accepted 는 이미 반영, rejected 는 기각 기록 — 재노출 0 (AC6) ----

const mergeKey = (m: { name: string; node: string }) => `${m.name}\u0000${m.node}`;
const typingKey = (t: { s: string; o: string; note: string }) => `${t.s}\u0000${t.o}\u0000${t.note}`;

export function enqueueMerges(queue: ReviewQueue, proposals: readonly MergeProposal[]): ReviewQueue {
  const seen = new Set(queue.merges.map(mergeKey));
  const added: MergeItem[] = [];
  for (const p of proposals) {
    const key = mergeKey(p);
    if (seen.has(key)) continue;
    seen.add(key);
    added.push({ name: p.name, node: p.node, confidence: p.confidence, status: "pending" });
  }
  return { ...queue, merges: [...queue.merges, ...added] };
}

export function enqueueTypings(queue: ReviewQueue, proposals: readonly TypingProposal[]): ReviewQueue {
  const seen = new Set(queue.typings.map(typingKey));
  const added: TypingItem[] = [];
  for (const p of proposals) {
    const key = typingKey(p);
    if (seen.has(key)) continue;
    seen.add(key);
    added.push({ s: p.s, o: p.o, note: p.note, status: "pending" });
  }
  return { ...queue, typings: [...queue.typings, ...added] };
}

// 동사 제안 관측 — registry.observe 의 임계·기각 기록 규율을 그대로 쓴다.
export function observeVerbs(queue: ReviewQueue, observations: readonly Observation[]): ReviewQueue {
  let verbs = queue.verbs;
  for (const o of observations) verbs = observe(verbs, o);
  return { ...queue, verbs };
}

// ---- 화면 목록 (AC3) — 유형별 pending 만. 무응답은 영원히 pending 이다: 시간 기반 전이가
// 이 모듈에 없다는 것이 AC4(자동 수락 0)의 구조적 보장이다 ----

export interface PendingView {
  verbs: Proposal[]; // status === "proposed" — 임계를 넘긴 것만 사람 앞에 선다
  merges: MergeItem[];
  typings: TypingItem[];
  inferences: InferenceItem[];
}

export function pendingItems(queue: ReviewQueue): PendingView {
  return {
    verbs: queue.verbs.filter((p) => p.status === "proposed"),
    merges: queue.merges.filter((m) => m.status === "pending"),
    typings: queue.typings.filter((t) => t.status === "pending"),
    inferences: queue.inferences.filter((i) => i.status === "pending"),
  };
}

// ---- 확정 — 전부 사람의 호출이다. 수락의 효과는 값으로 돌려주고, 정본 반영(recordAliases ·
// recordDistinction · applyPatch · confirmProposal)은 호출자가 잇는다 ----

function findMerge(queue: ReviewQueue, name: string, node: string): MergeItem {
  const item = queue.merges.find((m) => m.name === name && m.node === node);
  if (!item) throw new ReviewError([`병합 제안이 없다: ${name} → ${node}`]);
  if (item.status !== "pending") {
    throw new ReviewError([`이미 확정된 병합 제안이다 (${item.status}): ${name} → ${node}`]);
  }
  return item;
}

// 수락 → recordAliases 입력. 큐는 accepted 로 남아 재적재를 막는다.
export function acceptMerge(
  queue: ReviewQueue,
  name: string,
  node: string,
): { queue: ReviewQueue; alias: { node: string; alias: string } } {
  const item = findMerge(queue, name, node);
  return {
    queue: {
      ...queue,
      merges: queue.merges.map((m) => (m === item ? { ...m, status: "accepted" as const } : m)),
    },
    alias: { node, alias: name },
  };
}

// 기각 → recordDistinction 입력 — 분리 판정의 박제가 정규화의 후보 제외로 이어진다 (#9 AC5).
export function rejectMerge(
  queue: ReviewQueue,
  name: string,
  node: string,
): { queue: ReviewQueue; distinction: [string, string] } {
  const item = findMerge(queue, name, node);
  return {
    queue: {
      ...queue,
      merges: queue.merges.map((m) => (m === item ? { ...m, status: "rejected" as const } : m)),
    },
    distinction: [name, node],
  };
}

function findTyping(queue: ReviewQueue, s: string, o: string, note: string): TypingItem {
  const item = queue.typings.find((t) => t.s === s && t.o === o && t.note === note);
  if (!item) throw new ReviewError([`타이핑 제안이 없다: ${s} → ${o} (${note})`]);
  if (item.status !== "pending") {
    throw new ReviewError([`이미 확정된 타이핑 제안이다 (${item.status}): ${s} → ${o}`]);
  }
  return item;
}

// 수락 → 폴백 엣지를 사람이 고른 동사로 바꾸는 패치. 확정은 사람이므로 by:user 다.
export function acceptTyping(
  queue: ReviewQueue,
  s: string,
  o: string,
  note: string,
  verbId: string,
): { queue: ReviewQueue; patch: Patch } {
  const item = findTyping(queue, s, o, note);
  if (verbId === FALLBACK_VERB_ID) {
    throw new ReviewError([`타이핑 수락의 동사가 폴백(${FALLBACK_VERB_ID})이다 — 타이핑이 아니다`]);
  }
  return {
    queue: {
      ...queue,
      typings: queue.typings.map((t) => (t === item ? { ...t, status: "accepted" as const } : t)),
    },
    patch: {
      add: [
        {
          s,
          v: verbId,
          o,
          confidence: 1,
          fallback: false,
          by: "user",
          src: { note, origin: "wikilink" },
        },
      ],
      retract: [{ s, v: FALLBACK_VERB_ID, o, note }],
    },
  };
}

export function rejectTyping(queue: ReviewQueue, s: string, o: string, note: string): ReviewQueue {
  const item = findTyping(queue, s, o, note);
  return {
    ...queue,
    typings: queue.typings.map((t) => (t === item ? { ...t, status: "rejected" as const } : t)),
  };
}

// ---- 재부상 판정 대기 (#80) — 같은 fingerprint 는 상태 불문 다시 서지 않는다 (재노출 0,
// enqueueMerges 와 같은 규율). 해소는 전부 사람의 호출이다 — 기계 자동 해소 경로가 없다 (AC2) ----

export function enqueueInferences(
  queue: ReviewQueue,
  findings: readonly { fingerprint: string; kind: "contradiction" | "gap"; summary: string; edges: InferenceItem["edges"] }[],
): { queue: ReviewQueue; added: number } {
  const seen = new Set(queue.inferences.map((i) => i.fingerprint));
  const added: InferenceItem[] = [];
  for (const f of findings) {
    if (seen.has(f.fingerprint)) continue;
    seen.add(f.fingerprint);
    added.push({ ...f, status: "pending" });
  }
  return { queue: { ...queue, inferences: [...queue.inferences, ...added] }, added: added.length };
}

function findInference(queue: ReviewQueue, fingerprint: string): InferenceItem {
  const item = queue.inferences.find((i) => i.fingerprint === fingerprint);
  if (!item) throw new ReviewError([`판정 대기 항목이 없다: ${fingerprint}`]);
  if (item.status !== "pending") {
    throw new ReviewError([`이미 확정된 항목이다 (${item.status}): ${fingerprint}`]);
  }
  return item;
}

/** 무시(둘 다 유지·확인) — rejected 로 남아 재노출을 막는다. */
export function dismissInference(queue: ReviewQueue, fingerprint: string): ReviewQueue {
  findInference(queue, fingerprint);
  return {
    ...queue,
    inferences: queue.inferences.map((i) =>
      i.fingerprint === fingerprint ? { ...i, status: "rejected" as const } : i,
    ),
  };
}

/** 모순의 한쪽 철회 수락 — 철회 입력을 값으로 돌려주고, 정본 반영(applyPatch)은 호출자가 잇는다. */
export function acceptInferenceRetract(
  queue: ReviewQueue,
  fingerprint: string,
  edgeIndex: number,
): { queue: ReviewQueue; retract: { s: string; v: string; o: string; note: string | null } } {
  const item = findInference(queue, fingerprint);
  if (item.kind !== "contradiction") throw new ReviewError([`철회는 모순 항목에만 선다: ${fingerprint}`]);
  const edge = item.edges[edgeIndex];
  if (edge === undefined) throw new ReviewError([`철회 후보가 없다: ${fingerprint}[${edgeIndex}]`]);
  return {
    queue: {
      ...queue,
      inferences: queue.inferences.map((i) =>
        i.fingerprint === fingerprint ? { ...i, status: "accepted" as const } : i,
      ),
    },
    retract: edge,
  };
}
