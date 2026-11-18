// 파이프라인 조립 (F2 → F3) — 추출 산출이 정본(F4)에 닿기 전의 마지막 단: 엔터티 정규화
// (이슈 #47 · CLAUDE.md §1 「필수 파이프라인 단계」 — #270 재현율 갭 0.27 이 전부 표면명
// 변형이었다). hub.ts(추출)와 normalize.ts(정규화 판정)를 순수 조립한다 — 두 모듈은 서로를
// 모른다(순환 의존 0). API1·API2 의 서빙 경로는 extract* 가 아니라 이 모듈의 process* 다.
import {
  extractIncremental,
  extractReindex,
  type Engine,
  type IncrementalRequest,
  type IncrementalResponse,
  type ReindexRequest,
  type ReindexResponse,
} from "./hub.js";
import { applyResolutions, normalizeEntities, resolveDeixis, type MergeProposal } from "./normalize.js";
import type { EdgeRetract, EdgeWrite, NormalizationDictionary } from "./store.js";

// 정규화가 응답에 더하는 것 — 둘 다 정본 면의 입력 재료다.
export interface NormalizedExtras {
  /** 임계 위 병합이 보존한 표기 — recordAliases 의 입력 (AC1). */
  aliases: { node: string; alias: string }[];
  /** 임계 미만 병합 후보 — S2 검토함 제안: 정본 자동 병합 0 (AC2), 확정은 사람 몫. */
  merges: MergeProposal[];
}

// 허브는 무상태라 별칭 사전도 요청에 실려 온다 (설계 결정 ⓐ — 출처는 언제나 정본).
// 안 실리면 빈 사전으로 돈다 — 배치 안 변형 병합과 문맥 노드 대조는 그래도 선다.
export interface PipelineIncrementalRequest extends IncrementalRequest {
  dictionary?: NormalizationDictionary;
}
export type PipelineIncrementalResponse = IncrementalResponse & NormalizedExtras;

export interface PipelineReindexRequest extends ReindexRequest {
  dictionary?: NormalizationDictionary;
}
export type PipelineReindexResponse = ReindexResponse & NormalizedExtras;

// 문맥 엣지의 s·o 는 정본 노드명이다(projectionDataFor 출처) — 사전이 부분적이어도
// 문맥에 보이는 노드는 병합 후보가 된다 (AC1 의 「문맥에 있고」).
function withNames(dictionary: NormalizationDictionary, names: Iterable<string>): NormalizationDictionary {
  const present = new Set<string>();
  for (const node of dictionary.nodes) {
    present.add(node.name);
    for (const alias of node.aliases) present.add(alias);
  }
  const nodes = [...dictionary.nodes];
  for (const raw of names) {
    const name = raw.trim();
    if (name.length === 0 || present.has(name)) continue;
    present.add(name);
    nodes.push({ name, aliases: [] });
  }
  return { nodes, distinctions: dictionary.distinctions };
}

const emptyDictionary = (): NormalizationDictionary => ({ nodes: [], distinctions: [] });

// 정규화로 같은 트리플이 된 중복만 접는다 — 출처 노트가 다르면 다른 기록이라 남긴다.
function dedupeBy<T>(items: readonly T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const k = key(item);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

async function normalizeOutputs(
  engine: Engine,
  dictionary: NormalizationDictionary,
  add: EdgeWrite[],
  retract: EdgeRetract[],
  onName?: (done: number, total: number) => void,
): Promise<{ add: EdgeWrite[]; retract: EdgeRetract[] } & NormalizedExtras> {
  // 지시어 해소 (ISSUE-519) — 「이 티켓」이 이름으로 판정대에 오르기 전에 출처 노트 제목으로
  // 풀린다. 결정 연산(엔진 0)이라 이 단의 비용은 0 이고, 지시어 없는 입력은 그대로 지난다.
  const addResolved = resolveDeixis(add, (e) => e.src.note ?? "");
  const retractResolved = resolveDeixis(retract, (e) => e.note ?? "");
  const names = [...addResolved, ...retractResolved].flatMap((e) => [e.s, e.o]);
  if (names.length === 0) return { add: addResolved, retract: retractResolved, aliases: [], merges: [] };
  // 판정 실패는 normalize.ts 의 보수 기본(미병합 통과·기록)이 삼킨다 (#9 AC4) — 여기서
  // 추출 산출이 유실되는 경로는 없다.
  const result = await normalizeEntities(engine, { names, dictionary }, onName);
  return {
    add: dedupeBy(
      applyResolutions(addResolved, result.resolutions),
      (e) => `${e.s}\u0000${e.v}\u0000${e.o}\u0000${e.src.note}`,
    ),
    retract: dedupeBy(
      applyResolutions(retractResolved, result.resolutions),
      (e) => `${e.s}\u0000${e.v}\u0000${e.o}\u0000${e.note}`,
    ),
    aliases: result.aliases,
    merges: result.proposals,
  };
}

// ---- API1 서빙 경로 — 추출 → 정규화 ----

export async function processIncremental(
  engine: Engine,
  request: PipelineIncrementalRequest,
  /** 진행 보고 (ISSUE-487 F6) — 추출 단의 노트 닫힘을 센다. */
  onNote?: (done: number, total: number) => void,
  /** 이름 진행 (ISSUE-517) — 정규화 단은 분모가 다르다(노트가 아니라 고유 이름): 제 콜백이 있다. */
  onName?: (done: number, total: number) => void,
): Promise<PipelineIncrementalResponse> {
  const extracted = await extractIncremental(engine, request, onNote);
  const dictionary = withNames(
    request.dictionary ?? emptyDictionary(),
    (request.context ?? []).flatMap((e) => [e.s, e.o]),
  );
  const normalized = await normalizeOutputs(engine, dictionary, extracted.add, extracted.retract, onName);
  return {
    add: normalized.add,
    retract: normalized.retract,
    proposals: extracted.proposals,
    held: extracted.held,
    aliases: normalized.aliases,
    merges: normalized.merges,
  };
}

// ---- API2 서빙 경로 — 재색인도 같은 단을 지난다 ----

export async function processReindex(
  engine: Engine,
  request: PipelineReindexRequest,
  /** 진행 보고 (ISSUE-487 F6) — 추출 단의 노트 닫힘을 센다. */
  onNote?: (done: number, total: number) => void,
  /** 이름 진행 (ISSUE-517) — 최초 색인의 정규화는 수십 분이다: 침묵이 멈춤으로 읽히지 않게. */
  onName?: (done: number, total: number) => void,
): Promise<PipelineReindexResponse> {
  const extracted = await extractReindex(engine, request, onNote);
  const normalized = await normalizeOutputs(
    engine,
    request.dictionary ?? emptyDictionary(),
    extracted.edges,
    [],
    onName,
  );
  return {
    edges: normalized.add,
    proposals: extracted.proposals,
    held: extracted.held,
    versions: extracted.versions,
    aliases: normalized.aliases,
    merges: normalized.merges,
  };
}
