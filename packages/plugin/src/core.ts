// 코어 공개 표면의 이음새 — 플러그인이 코어의 파일 경로를 아는 곳은 이 파일뿐이다.
// @ontoflow/core 에는 아직 패키지 진입점(배럴)이 없다. 이 이슈의 AC3(코어 공개 시그니처 변경 0)가
// 「플러그인은 조립만 한다」의 구조적 증명이라, 배럴을 코어에 세우는 대신 여기서 모은다 —
// 코어 진입점 정리는 허브 조립(#43)이 같은 필요를 가질 때 별건으로 간다.

export {
  ONTOFLOW_DIR,
  REGISTRY_FILE,
  StoreError,
  applyPatch,
  configureSqlJs,
  loadDictionary,
  markShared,
  openVault,
  rebuild,
  recordAliases,
  recordDistinction,
  resolveHome,
  retractNote,
  retractShare,
  loadProjection,
  recordProjectionResult,
  vaultRelative,
} from "../../core/src/store.js";
// 동기화(투영) 집행 재료 (ISSUE-372) — 델타는 로컬 정본에서 뜨고, 판정은 허브가 진다.
export { computeNotionDelta } from "../../core/src/notion.js";
export type { ProjectionDest } from "../../core/src/store.js";
export type {
  EdgeRetract,
  EdgeWrite,
  FileIo,
  GraphHome,
  GraphStore,
  NormalizationDictionary,
  Patch,
  PatchResult,
} from "../../core/src/store.js";

// API 소스 오케스트레이션 (ISSUE-364) — 분모는 허브 금고의 연결, 전송은 주입(main 이 조립).
export { collectApiSource, collectGitHubSources, isApiSourceKind } from "../../core/src/api-sources.js";
export type { ApiSourceKind, IngestPull } from "../../core/src/api-sources.js";

export { designateHome } from "../../core/src/home.js";
export type { DesignateResult } from "../../core/src/home.js";

export {
  collectDelete,
  collectRename,
  collectWrite,
  drainHold,
  enqueueHold,
  loadCollectState,
  loadHoldQueue,
  reconcile,
  saveCollectState,
  saveHoldQueue,
  stripProjection,
} from "../../core/src/collect.js";
export type {
  CollectedChange,
  HoldQueue,
  TypingProposal,
  VaultFileStat,
  VaultReader,
} from "../../core/src/collect.js";

export {
  IngestError,
  SOURCE_KINDS,
  collectRegisteredSources,
  parseIngestSources,
  registerSource,
  removeSourceState,
  unregisterSource,
} from "../../core/src/sources.js";
export type { IngestSource, SourceKind, SourceReader } from "../../core/src/sources.js";

export {
  RESURFACE_NOTE_ID,
  deltaSince,
  findContradictions,
  findGaps,
  isReportDue,
  loadResurfaceState,
  renderResurfaceReport,
  saveResurfaceState,
} from "../../core/src/resurface.js";
export type { ResurfaceFinding, ResurfaceState } from "../../core/src/resurface.js";

// 첫 색인 하이라이트 (#89) — 온보딩 완료 화면의 「이게 네 노트에서 나왔다」.
export { firstIndexHighlights } from "../../core/src/resurface.js";
export type { FirstIndexHighlight } from "../../core/src/resurface.js";

export { dumpCanonical, restoreCanonical } from "../../core/src/pg-store.js";
export type { InboxNote, PeekedInboxNote } from "../../core/src/pg-store.js";
export { captureToInbox } from "../../core/src/capture.js";
export type { CanonicalDump } from "../../core/src/pg-store.js";

export {
  BEAR_DB_RELATIVE_PATH,
  BearError,
  bearSourceReader,
  readBearNotes,
} from "../../core/src/bear.js";
export type { BearNotes } from "../../core/src/bear.js";
export { openSqlDatabase } from "../../core/src/store.js";

export {
  SYNTHESIS_DIR,
  SynthesisError,
  designateSynthesisDir,
  loadSynthesisState,
  saveSynthesisState,
  synthesisInputFor,
  writeSynthesisNote,
} from "../../core/src/synthesis.js";
export type { SynthesisInput, SynthesisNote, SynthesisState } from "../../core/src/synthesis.js";

export {
  OnboardingError,
  abortInitialIndex,
  chooseVault,
  connectHub,
  emptyOnboarding,
  grantConsent,
  loadOnboarding,
  progressLabel,
  recordIndexProgress,
  saveOnboarding,
  startInitialIndex,
} from "../../core/src/onboarding.js";
export type { OnboardingState } from "../../core/src/onboarding.js";

export {
  enqueueInferences,
  dismissInference,
  acceptInferenceRetract,
  ReviewError,
  acceptMerge,
  acceptTyping,
  emptyReviewQueue,
  enqueueMerges,
  enqueueTypings,
  loadReviewQueue,
  observeVerbs,
  pendingItems,
  rejectMerge,
  rejectTyping,
  saveReviewQueue,
} from "../../core/src/review.js";
export type { InferenceItem } from "../../core/src/review.js";
export type { MergeItem, PendingView, ReviewQueue, TypingItem } from "../../core/src/review.js";

export {
  FALLBACK_VERB_ID,
  RegistryError,
  SEED_REGISTRY,
  SUPERCLASSES,
  confirmProposal,
  suggestVerbId,
  parseRegistry,
  rejectProposal,
  serializeRegistry,
} from "../../core/src/registry.js";
export type { Observation, Proposal, Registry, Superclass, Verb } from "../../core/src/registry.js";

export { collectProjectionEdits, parseProjection, projectionDataFor, projectNote } from "../../core/src/project.js";
export type { ProjectionData } from "../../core/src/project.js";

export { exportGraphMl, exportJsonLd } from "../../core/src/export.js";

export type {
  ContextEdge,
  HeldNote,
  IncrementalChange,
  ReindexNote,
} from "../../core/src/hub.js";

// 허브 응답의 플러그인 쪽 꼴 — 추출 + 정규화 단(aliases·merges)을 지난 응답이다 (이슈 #47).
export type {
  PipelineIncrementalResponse,
  PipelineReindexResponse,
} from "../../core/src/pipeline.js";

// BYO 추출 (#88) — 허브가 도는 그 파이프라인을 플러그인이 로컬 엔진으로 그대로 돌린다.
export { processIncremental, processReindex } from "../../core/src/pipeline.js";
export { openAiCompatEngine } from "../../core/src/engine.js";
export type { EngineFetchLike } from "../../core/src/engine.js";
export type { Engine } from "../../core/src/hub.js";

export { SENSITIVE_CONSENT_TEXT } from "../../core/src/billing.js";

export type { MergeProposal } from "../../core/src/normalize.js";
