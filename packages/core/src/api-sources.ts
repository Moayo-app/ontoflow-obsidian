// API 소스 오케스트레이션 (ISSUE-364) — 「연결은 되는데 아무것도 들어오지 않는다」의 반대편:
// 연결된 API 소스(허브 금고의 수집 자격증명)를 플러그인 수집 사이클이 당겨 오는 공통 배선이다.
//
// 구조: 소스별 어댑터(onenote.ts·notion-ingest.ts·…)는 이미 셋을 다 가진다 — known(증분 선별
// 재료)·허브 pull 라우트·pulledReader(SourceReader 조립). 이 모듈은 그 아홉을 한 꼴로 묶고,
// 수집 상태(sources.json — #55 와 같은 자리)를 돌리는 루프 하나만 더한다. 전송(pull)은 주입이다 —
// 코어는 허브 클라이언트를 모른다 (플러그인 main 이 조립, 테스트는 가짜).
//
// ⭕ 트리거 판정 (이 티켓 ②): **멤버 세션(플러그인)이 오케스트레이터다** — 허브 타이머 비채택.
// 보관 0 과 정합한다(허브는 버퍼 안 pull → 응답뿐, 산출 저장 자리가 없다) · 상시 표면 +0(스케줄러
// 돌봄이 없다) · 워크스페이스 소스(관리자가 금고에 연결)는 멤버 플러그인이 workspaceId 문맥으로
// 같은 길을 당긴다 — 산출이 멤버 그래프에 서고 공유 표시·투영이 합집합으로 나른다 (#53·#214).
import { confluenceKnownOf, confluencePulledReader, jiraKnownOf, jiraPulledReader } from "./atlassian.js";
import { dropboxKnownOf, dropboxPulledReader } from "./dropbox.js";
import { evernoteKnownOf, evernotePulledReader } from "./evernote.js";
import { gdriveKnownOf, gdrivePulledReader } from "./gdrive.js";
import { githubKnownOf, githubPulledReader } from "./github.js";
import { gitlabKnownOf, gitlabPulledReader } from "./gitlab.js";
import { notionKnownStatsOf, notionPulledReader } from "./notion-ingest.js";
import { oneNotePulledReader } from "./onenote.js";
import {
  collectSource,
  loadSourceStates,
  saveSourceStates,
  sourceKnownStats,
  type SourceReader,
} from "./sources.js";
import { emptyCollectState, type CollectState, type CollectedChange } from "./collect.js";
import type { FileIo } from "./store.js";

/** 허브 수집 라우트의 꼬리 이름 — 수집 상태의 소스 id 로도 그대로 쓴다 (경로 접두 `<kind>:/`). */
export const API_SOURCE_KINDS = [
  "onenote",
  "notion",
  "evernote",
  "gdrive",
  "dropbox",
  "gitlab",
  "github",
  "jira",
  "confluence",
] as const;
export type ApiSourceKind = (typeof API_SOURCE_KINDS)[number];

export function isApiSourceKind(v: unknown): v is ApiSourceKind {
  return typeof v === "string" && (API_SOURCE_KINDS as readonly string[]).includes(v);
}

/**
 * 금고 목적지 → 당길 수 있는 소스 kind — 허브 `POST /v1/ingest/sources` 가 이 사상으로 답한다.
 * atlassian 자격 하나가 jira·confluence 둘을 당기는 것(#314 — 한 자격의 묶음)이 유일한 1:2 다.
 */
export const INGEST_DESTINATION_KINDS: Readonly<Record<string, readonly ApiSourceKind[]>> = {
  onenote: ["onenote"],
  "notion-ingest": ["notion"],
  evernote: ["evernote"],
  gdrive: ["gdrive"],
  dropbox: ["dropbox"],
  gitlab: ["gitlab"],
  github: ["github"],
  atlassian: ["jira", "confluence"],
};

/** 주입되는 전송 — 허브 `POST /v1/ingest/<kind>` 한 번: known 을 싣고 pull 결과(JSON)를 받는다.
 * anchor 는 복수 닻 kind(지금은 github — ISSUE-482)만 싣는다: 어느 저장소의 pull 인지다. */
export type IngestPull = (kind: ApiSourceKind, known: unknown, anchor?: string) => Promise<unknown>;

interface Adapter {
  known(state: CollectState, sourceId: string): unknown;
  reader(doc: unknown, state: CollectState, sourceId: string): SourceReader;
}

// 응답은 각 어댑터의 *Pull 꼴(JSON 왕복 안전)이다 — 여기서의 cast 는 그 계약의 표면화일 뿐,
// 꼴이 어긋난 응답은 reader 적재 단계가 명시 오류로 세운다 (조용한 0 수집 없음).
const ADAPTERS: Readonly<Record<ApiSourceKind, Adapter>> = {
  onenote: {
    known: (state, id) => sourceKnownStats(state, id),
    reader: (doc) => oneNotePulledReader(doc as Parameters<typeof oneNotePulledReader>[0]),
  },
  notion: {
    known: (state, id) => notionKnownStatsOf(state, id),
    reader: (doc, state, id) => notionPulledReader(doc as Parameters<typeof notionPulledReader>[0], state, id),
  },
  evernote: {
    known: (state, id) => evernoteKnownOf(state, id),
    reader: (doc) => evernotePulledReader(doc as Parameters<typeof evernotePulledReader>[0]),
  },
  gdrive: {
    known: (state, id) => gdriveKnownOf(state, id),
    reader: (doc) => gdrivePulledReader(doc as Parameters<typeof gdrivePulledReader>[0]),
  },
  dropbox: {
    known: (state, id) => dropboxKnownOf(state, id),
    reader: (doc) => dropboxPulledReader(doc as Parameters<typeof dropboxPulledReader>[0]),
  },
  gitlab: {
    known: (state, id) => gitlabKnownOf(state, id),
    reader: (doc) => gitlabPulledReader(doc as Parameters<typeof gitlabPulledReader>[0]),
  },
  github: {
    known: (state, id) => githubKnownOf(state, id),
    reader: (doc) => githubPulledReader(doc as Parameters<typeof githubPulledReader>[0]),
  },
  jira: {
    known: (state, id) => jiraKnownOf(state, id),
    reader: (doc) => jiraPulledReader(doc as Parameters<typeof jiraPulledReader>[0]),
  },
  confluence: {
    known: (state, id) => confluenceKnownOf(state, id),
    reader: (doc) => confluencePulledReader(doc as Parameters<typeof confluencePulledReader>[0]),
  },
};

/**
 * API 소스 한 종의 따라잡기 수집 — known 을 싣고 허브에서 당겨, 같은 reconcile(디프·위키링크
 * 폴백·메아리 차단)에 태운다. 수집 상태는 파일 소스와 같은 sources.json 에 kind 이름의 소스로
 * 산다 — 연결 사실(금고)이 분모이고(#74 AC4 승계) 플러그인 설정 목록에는 오르지 않는다.
 * 산출은 vault 수집과 같은 CollectedChange[] — 호출자가 같은 파이프라인에 태운다.
 */
export async function collectApiSource(
  io: FileIo,
  vaultDir: string,
  kind: ApiSourceKind,
  pull: IngestPull,
  instance?: ApiSourceInstance,
): Promise<CollectedChange[]> {
  const adapter = ADAPTERS[kind];
  const sourceId = instance?.sourceId ?? kind;
  const states = await loadSourceStates(io, vaultDir);
  const state = states.sources[sourceId] ?? emptyCollectState();
  states.sources[sourceId] = state;
  const doc = await pull(kind, adapter.known(state, sourceId), instance?.anchor);
  // 무변 묶음 (증분의 싼 문 — ISSUE-482 에서 공통화): reader 는 무변을 명시 거부하므로(빈 목록
  // = 전체 삭제 오판 방지) 여기서 변경 0 으로 닫는다 — 상태·커서 무변, reconcile 비진입.
  // 전에는 이 throw 가 「수집 실패」 Notice 로 새던 잠복 소음이기도 했다.
  if (typeof doc === "object" && doc !== null && (doc as { unchanged?: unknown }).unchanged === true) {
    return [];
  }
  const changes = await collectSource(
    adapter.reader(doc, state, sourceId),
    { id: sourceId, kind: "md", root: instance?.root ?? `api:${kind}` },
    state,
  );
  await saveSourceStates(io, vaultDir, states);
  return changes;
}

// ---- 복수 닻 (ISSUE-482) — 저장소 = 소스: known·커서·경로가 소스 id 층에서 공짜로 갈린다 ----

/** 복수 닻 kind 의 소스 한 벌 — sourceId 가 수집 상태의 키이자 vault 경로 접두의 뿌리다. */
export interface ApiSourceInstance {
  anchor: string;
  sourceId: string;
  root: string;
}

/** 승계 닻은 소스 id `"github"`(옛 경로·과금 장부 그대로), 나머지는 저장소별 id 다. */
export function githubSourceInstances(anchors: readonly string[], primary: string): ApiSourceInstance[] {
  return anchors.map((anchor) => {
    if (anchor === primary) return { anchor, sourceId: "github", root: "api:github" };
    const sourceId = `github--${githubAnchorSlug(anchor)}`;
    return { anchor, sourceId, root: `api:${sourceId}` };
  });
}

/** 저장소 이름 → 소스 id 조각 — 소문자 슬러그 + 해시4(대소문자·특수문자 접힘의 충돌 봉합).
 * `.` 시작 마디(isSourceCollectable 의 숨김 필터)와 `/` 가 슬러그에서 접히므로 경로 지뢰가 없다. */
export function githubAnchorSlug(anchor: string): string {
  const slug = anchor.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  let h = 5381;
  for (let i = 0; i < anchor.length; i++) h = ((h * 33) ^ anchor.charCodeAt(i)) >>> 0;
  return `${slug === "" ? "repo" : slug}-${h.toString(16).padStart(4, "0").slice(-4)}`;
}

/**
 * GitHub 전 저장소 수집 (ISSUE-482) — 저장소별 소스를 차례로 당기고 **오류를 격리**한다:
 * 한 저장소의 자격 상실(404·권한)이 나머지 수집을 세우지 않는다. 실패 저장소는 그 소스의
 * reconcile 자체가 돌지 않으므로 기존 항목이 삭제로 오판될 길이 없고(조용한 빈 수집 아님 —
 * problems 가 저장소명을 전부 나열한다), 성공분은 그대로 파이프라인에 탄다.
 */
export async function collectGitHubSources(
  io: FileIo,
  vaultDir: string,
  anchors: readonly string[],
  primary: string,
  pull: IngestPull,
): Promise<{ changes: CollectedChange[]; problems: string[] }> {
  const changes: CollectedChange[] = [];
  const problems: string[] = [];
  for (const instance of githubSourceInstances(anchors, primary)) {
    try {
      changes.push(...(await collectApiSource(io, vaultDir, "github", pull, instance)));
    } catch (e) {
      problems.push(`${instance.anchor}: ${(e as Error).message}`);
    }
  }
  return { changes, problems };
}
