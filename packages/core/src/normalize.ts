// 엔터티 정규화·별칭 병합 (F3) — 필수 파이프라인 단계: #270 의 재현율 갭 0.27 이 전부
// 표면명 변형이었다 (이슈 #9 · 스펙 AC15·AC16). 판정 수단은 사전 + 엔진뿐 — 임베딩 비범위.
// 허브 면(무상태): 사전은 요청에 실려 오고, 박제·축적은 정본 면(store.ts)이 진다.
import { ENGINE_MODEL, HubError, assertEngineContract, type Engine, type EngineCall } from "./hub.js";
import type { NormalizationDictionary } from "./store.js";

// 자동 병합 임계 — 보수 기본: 오병합보다 미병합이 싸다 (스펙 AC16). 정책 설정값으로 덮어쓴다.
export const AUTO_MERGE_THRESHOLD = 0.8;

export interface NormalizationRequest {
  names: string[]; // 추출 산출의 표면명들 (s·o)
  dictionary: NormalizationDictionary;
  threshold?: number;
}

export interface NameResolution {
  name: string; // 입력 표면명
  node: string; // 귀속된 노드 이름 — 미병합·신규면 자기 자신
  via: "exact" | "alias" | "merge" | "new";
  confidence?: number; // via:merge 의 판정 확신도
}

// 임계 미만 판정은 병합하지 않고 검토 큐(S2) 제안으로만 올라간다 — 수동 병합은 사람 몫.
export interface MergeProposal {
  kind: "merge";
  name: string;
  node: string;
  confidence: number;
}

export interface NormalizationFailure {
  name: string;
  reason: string;
}

export interface NormalizationResult {
  resolutions: NameResolution[];
  aliases: { node: string; alias: string }[]; // 병합이 보존하는 표기 — recordAliases 입력
  proposals: MergeProposal[];
  failures: NormalizationFailure[]; // 판정 실패 기록 (AC4) — 전부 미병합으로 통과했다
}

// 판정 출력 스키마 — match 는 후보 노드 이름 아니면 null (enum 강제).
export function judgmentSchema(candidates: readonly string[]): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      match: { enum: [...candidates, null] },
      confidence: { type: "number", minimum: 0, maximum: 1 },
    },
    required: ["match", "confidence"],
    additionalProperties: false,
  };
}

export function buildJudgmentPrompt(
  name: string,
  candidates: readonly { name: string; aliases: string[] }[],
): string {
  const lines = candidates
    .map((c) => (c.aliases.length > 0 ? `- ${c.name} (별칭: ${c.aliases.join(", ")})` : `- ${c.name}`))
    .join("\n");
  const rules = [
    "새 표기가 기존 노드와 같은 개념의 다른 표기일 때만 그 노드 이름을 match 로 낸다.",
    "의심스러우면 null 이다 — 오병합이 미병합보다 비싸다.",
    "표기가 비슷해도 다른 개념이면 null 이다.",
    "confidence 는 같은 개념이라는 확신도다.",
  ];
  return [
    "너는 지식 그래프의 엔터티 정규화 판정자다. 출력은 JSON 하나 — {match, confidence}.",
    `새 표기: 「${name}」`,
    `기존 노드:\n${lines}`,
    `규칙:\n${rules.map((r, i) => `${i + 1}. ${r}`).join("\n")}`,
  ].join("\n\n");
}

interface Judgment {
  match: string | null;
  confidence: number;
}

function parseJudgment(text: string, candidates: ReadonlySet<string>): Judgment {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    throw new HubError(422, [`JSON 오류: ${(e as Error).message}`]);
  }
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
    throw new HubError(422, ["판정 출력이 객체가 아닙니다"]);
  }
  const { match, confidence } = doc as Record<string, unknown>;
  const problems: string[] = [];
  if (match !== null && (typeof match !== "string" || !candidates.has(match))) {
    problems.push(`match 가 후보 밖입니다: ${JSON.stringify(match)}`);
  }
  if (typeof confidence !== "number" || confidence < 0 || confidence > 1) {
    problems.push(`confidence 가 [0,1] 밖입니다: ${JSON.stringify(confidence)}`);
  }
  if (problems.length > 0) throw new HubError(422, problems);
  return { match: match as string | null, confidence: confidence as number };
}

const pairKey = (a: string, b: string): string => (a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`);

// 별칭 사전 조회 → 미스 시 엔진 병합 판정(보수 기본). 같은 배치의 앞선 신규 노드도
// 뒤따르는 표기의 후보가 된다 — 「표면명 변형 둘」 이 한 배치로 와도 한 노드가 된다 (AC1).
export async function normalizeEntities(
  engine: Engine,
  request: NormalizationRequest,
): Promise<NormalizationResult> {
  const threshold = request.threshold ?? AUTO_MERGE_THRESHOLD;
  const result: NormalizationResult = { resolutions: [], aliases: [], proposals: [], failures: [] };

  // 작업 사전 — 배치가 진행되며 자란다 (신규 노드·병합 별칭).
  const working = new Map<string, { name: string; aliases: string[] }>(); // 노드명 → 노드
  const aliasOf = new Map<string, string>(); // 표기 → 노드명
  for (const node of request.dictionary.nodes) {
    working.set(node.name, { name: node.name, aliases: [...node.aliases] });
    for (const a of node.aliases) aliasOf.set(a, node.name);
  }
  const distinct = new Set(request.dictionary.distinctions.map(([a, b]) => pairKey(a, b)));
  const seen = new Set<string>();

  for (const rawName of request.names) {
    const name = rawName.trim();
    if (name.length === 0 || seen.has(name)) continue;
    seen.add(name);

    // 1) 사전 조회 — 히트면 엔진 호출 0 (AC3).
    if (working.has(name)) {
      result.resolutions.push({ name, node: name, via: "exact" });
      continue;
    }
    const owner = aliasOf.get(name);
    if (owner !== undefined) {
      result.resolutions.push({ name, node: owner, via: "alias" });
      continue;
    }

    // 2) 후보 — 분리 박제된 쌍은 후보에서 빠진다: 재병합 제안 0 (AC5).
    const candidates = [...working.values()].filter((c) => !distinct.has(pairKey(name, c.name)));
    const asNew = () => {
      result.resolutions.push({ name, node: name, via: "new" });
      working.set(name, { name, aliases: [] });
    };
    if (candidates.length === 0) {
      asNew();
      continue;
    }

    // 3) 엔진 병합 판정 — 실패는 보수 기본: 미병합으로 통과하고 기록한다 (AC4).
    const candidateNames = new Set(candidates.map((c) => c.name));
    const call: EngineCall = {
      model: ENGINE_MODEL,
      think: false,
      temperature: 0,
      prompt: buildJudgmentPrompt(name, candidates),
      schema: judgmentSchema([...candidateNames]),
    };
    assertEngineContract(call as unknown as Record<string, unknown>);
    let judgment: Judgment;
    try {
      judgment = parseJudgment(await engine.complete(call), candidateNames);
    } catch (e) {
      const reason = e instanceof HubError ? e.problems.join(" · ") : (e as Error).message;
      result.failures.push({ name, reason });
      asNew();
      continue;
    }

    // 4) 보수 기본 — null 이거나 박제 쌍이면 별도 노드, 임계 미만이면 제안만 (AC2).
    if (judgment.match === null || distinct.has(pairKey(name, judgment.match))) {
      asNew();
      continue;
    }
    if (judgment.confidence < threshold) {
      result.proposals.push({
        kind: "merge",
        name,
        node: judgment.match,
        confidence: judgment.confidence,
      });
      asNew();
      continue;
    }
    result.resolutions.push({
      name,
      node: judgment.match,
      via: "merge",
      confidence: judgment.confidence,
    });
    result.aliases.push({ node: judgment.match, alias: name });
    working.get(judgment.match)?.aliases.push(name);
    aliasOf.set(name, judgment.match);
  }
  return result;
}

// 패치의 표면명을 귀속 노드명으로 고쳐 쓴다 — 추출(F2) 산출이 정본(F4)에 닿기 전의 마지막 단.
export function applyResolutions<T extends { s: string; o: string }>(
  items: readonly T[],
  resolutions: readonly NameResolution[],
): T[] {
  const nodeOf = new Map(resolutions.map((r) => [r.name, r.node]));
  return items.map((item) => ({
    ...item,
    s: nodeOf.get(item.s.trim()) ?? item.s,
    o: nodeOf.get(item.o.trim()) ?? item.o,
  }));
}
