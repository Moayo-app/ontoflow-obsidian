// 화면 뷰모델 (S1 온보딩 · S2 검토함) — 옵시디언 UI 와 분리된 헤드리스 판단층.
// S1: `§23` 동의 전 「색인 시작」 비활성 (AC2). S2: 수락·기각 호출 하나하나만이 정본을 움직인다 —
// 일괄 수락 API 를 일부러 두지 않는 것이 자동 수락 0 의 구조적 보장이다 (AC6).
import {
  dismissInference,
  acceptInferenceRetract,
  SENSITIVE_CONSENT_TEXT,
  acceptMerge,
  acceptTyping,
  applyPatch,
  confirmProposal,
  loadOnboarding,
  loadReviewQueue,
  pendingItems,
  progressLabel,
  recordAliases,
  recordDistinction,
  rejectMerge,
  rejectProposal,
  rejectTyping,
  saveOnboarding,
  saveReviewQueue,
  type FileIo,
  type GraphStore,
  type OnboardingState,
  type PendingView,
  type Registry,
  type Verb,
} from "./core.js";
import { loadRegistryFile, saveRegistryFile } from "./registry-io.js";

export interface OnboardingView {
  hubConnected: boolean;
  vaultChosen: boolean;
  consentGranted: boolean;
  /** `§23` 별도 동의 문안 — 화면이 이 문구를 그대로 그린다. */
  consentText: string;
  /** AC2 — 동의(와 선행 단계) 전 false: 「색인 시작」 버튼 비활성의 근거. */
  canStartIndex: boolean;
  indexing: boolean;
  progress: string;
  completed: boolean;
}

export function onboardingView(state: OnboardingState): OnboardingView {
  return {
    hubConnected: state.hubConnected,
    vaultChosen: state.vaultChosen,
    consentGranted: state.consent !== null,
    consentText: SENSITIVE_CONSENT_TEXT,
    canStartIndex:
      state.hubConnected && state.vaultChosen && state.consent !== null && state.indexing === null,
    indexing: state.indexing !== null && state.completedAt === null,
    progress: progressLabel(state),
    completed: state.completedAt !== null,
  };
}

// 온보딩 전이의 영속 — 코어 전이 함수(connectHub·chooseVault·grantConsent…)를 받아 적용·저장한다.
export async function updateOnboarding(
  io: FileIo,
  vaultDir: string,
  advance: (state: OnboardingState) => OnboardingState,
): Promise<OnboardingState> {
  const next = advance(await loadOnboarding(io, vaultDir));
  await saveOnboarding(io, vaultDir, next);
  return next;
}

// ---- S2 — 검토함. 확정의 효과는 코어가 값으로 돌려주고, 정본 반영과 큐 영속을 여기서 잇는다 ----

export async function reviewView(io: FileIo, vaultDir: string): Promise<PendingView> {
  return pendingItems(await loadReviewQueue(io, vaultDir));
}

// 병합 수락 → 별칭 박제. 정본 반영이 먼저다 — 실패하면 큐는 pending 그대로 남는다.
export async function acceptMergeAction(
  io: FileIo,
  vaultDir: string,
  store: GraphStore,
  name: string,
  node: string,
): Promise<void> {
  const { queue, alias } = acceptMerge(await loadReviewQueue(io, vaultDir), name, node);
  await recordAliases(store, [alias]);
  await saveReviewQueue(io, vaultDir, queue);
}

// 병합 기각 → 분리 판정 박제 — 같은 쌍은 다시 제안되지 않는다 (#9 AC5).
export async function rejectMergeAction(
  io: FileIo,
  vaultDir: string,
  store: GraphStore,
  name: string,
  node: string,
): Promise<void> {
  const { queue, distinction } = rejectMerge(await loadReviewQueue(io, vaultDir), name, node);
  await recordDistinction(store, distinction[0], distinction[1]);
  await saveReviewQueue(io, vaultDir, queue);
}

// 타이핑 수락 → 폴백 엣지가 사람이 고른 동사로 바뀐다 (by:user — 사용자 편집 항상 승).
export async function acceptTypingAction(
  io: FileIo,
  vaultDir: string,
  store: GraphStore,
  registry: Registry,
  s: string,
  o: string,
  note: string,
  verbId: string,
): Promise<void> {
  const { queue, patch } = acceptTyping(await loadReviewQueue(io, vaultDir), s, o, note, verbId);
  await applyPatch(store, registry, patch);
  await saveReviewQueue(io, vaultDir, queue);
}

export async function rejectTypingAction(
  io: FileIo,
  vaultDir: string,
  s: string,
  o: string,
  note: string,
): Promise<void> {
  const queue = rejectTyping(await loadReviewQueue(io, vaultDir), s, o, note);
  await saveReviewQueue(io, vaultDir, queue);
}

// 재부상 판정 (#80) — 무시는 기록만, 철회는 사용자 승인의 정본 반영이다 (사용자 편집 항상 승).
export async function dismissInferenceAction(io: FileIo, vaultDir: string, fingerprint: string): Promise<void> {
  const queue = dismissInference(await loadReviewQueue(io, vaultDir), fingerprint);
  await saveReviewQueue(io, vaultDir, queue);
}

export async function retractInferenceAction(
  io: FileIo,
  vaultDir: string,
  store: GraphStore,
  registry: Registry,
  fingerprint: string,
  edgeIndex: number,
): Promise<void> {
  const { queue, retract } = acceptInferenceRetract(await loadReviewQueue(io, vaultDir), fingerprint, edgeIndex);
  await applyPatch(store, registry, { add: [], retract: [retract] });
  await saveReviewQueue(io, vaultDir, queue);
}

// 동사 확정 → 등록부 버전 업 — 재색인 경로의 트리거다 (moayo-hq#271 결의 2).
export async function confirmVerbAction(
  io: FileIo,
  vaultDir: string,
  verbRaw: string,
  verb: Verb,
): Promise<Registry> {
  const queue = await loadReviewQueue(io, vaultDir);
  const registry = await loadRegistryFile(io, vaultDir);
  const result = confirmProposal(registry, queue.verbs, verbRaw, verb);
  await saveRegistryFile(io, vaultDir, result.registry);
  await saveReviewQueue(io, vaultDir, { ...queue, verbs: result.proposals });
  return result.registry;
}

export async function rejectVerbAction(io: FileIo, vaultDir: string, verbRaw: string): Promise<void> {
  const queue = await loadReviewQueue(io, vaultDir);
  await saveReviewQueue(io, vaultDir, { ...queue, verbs: rejectProposal(queue.verbs, verbRaw) });
}
