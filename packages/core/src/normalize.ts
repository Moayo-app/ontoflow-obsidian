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

// 후보 상한 (ISSUE-512) — 판정 프롬프트·스키마가 작업 사전 전체를 싣고 자라다, 775건 최초
// 색인에서 컨텍스트 상한(8k)을 넘어 뒤쪽 전 호출이 400 으로 꺾였다(2026-11-17 실측 —
// 86분간 2,019콜 거절). 어휘 유사 상위 K 만 싣는다: K 이하 사전에서는 종전과 동일하고
// (AC1~AC5 계약 무변), 거대 사전에서만 덜 비슷한 후보가 빠진다. 유사도 **바닥은 두지
// 않는다** — 어휘가 멀어도 같은 개념일 수 있다는 것이 이 단의 존재 이유라(잠↔수면),
// 어휘는 순위만 돌리고 판정은 끝까지 엔진 몫이다.
export const MAX_JUDGMENT_CANDIDATES = 16;

// 연속 실패 차단기 (ISSUE-512) — 엔진이 연속으로 거절하면(서빙 다운·전송 계약 결함) 남은
// 이름을 판정 없이 보수 통과시킨다: 수 시간의 거절 두들김 대신 몇 초의 완주다. 성공 하나가
// 카운터를 끊으므로 일시 장애는 스스로 복귀한다.
export const ENGINE_FAILURE_FUSE = 10;

// 표면 꼴 가드 (ISSUE-554) — 파일 경로·URL·백틱 코드 꼴은 평문 개념과 같은 종이 아니다.
// 실측(2026-11-18 라이브 그래프): 「Henry 판정 2026-11-03」 노드에 `packages/core/src/plans.ts`
// 가 별칭으로 붙었다 — 경로를 품은 수다스러운 표기가 먼저 별칭이 되자, 그 안의 경로 조각이
// 포함 유사(0.5)로 딸려 온 연쇄다. 꼴이 다르면 어휘가 아무리 비슷해도 후보가 아니다 —
// 같은 꼴끼리(경로↔경로·평문↔평문)는 종전대로 판정에 선다.
export const CODE_SHAPE_RE = /[/\\`]|^https?:\/\//i;
const shapeOf = (s: string): "code" | "plain" => (CODE_SHAPE_RE.test(s) ? "code" : "plain");

const strippedOf = (s: string): string => s.toLowerCase().replace(/\s+/g, "");

const bigramsOf = (s: string): Set<string> => {
  const out = new Set<string>();
  for (let i = 0; i + 1 < s.length; i++) out.add(s.slice(i, i + 2));
  return out;
};

// 문자 바이그램 Dice + 포함 관계 — 표면명 변형(띄어쓰기·어미·축약)이 높게 서는 싼 척도.
function lexicalSimilarity(
  name: string,
  grams: ReadonlySet<string>,
  cand: { name: string; aliases: string[]; degree?: number },
): number {
  let best = 0;
  for (const surface of [cand.name, ...cand.aliases]) {
    const s = strippedOf(surface);
    if (s.length === 0) continue;
    const n = strippedOf(name);
    let score = n.length > 0 && (s.includes(n) || n.includes(s)) ? 0.5 : 0;
    const sg = bigramsOf(s);
    if (grams.size > 0 && sg.size > 0) {
      let hit = 0;
      for (const g of sg) if (grams.has(g)) hit++;
      score = Math.max(score, (2 * hit) / (grams.size + sg.size));
    }
    if (score > best) best = score;
  }
  return best;
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
  /** 이름 진행 (ISSUE-517) — 사전 히트도 센다: 분모는 전체 고유 이름 수, 막대의 재료다. */
  onName?: (done: number, total: number) => void,
): Promise<NormalizationResult> {
  const threshold = request.threshold ?? AUTO_MERGE_THRESHOLD;
  const result: NormalizationResult = { resolutions: [], aliases: [], proposals: [], failures: [] };
  const totalNames = new Set(request.names.map((n) => n.trim()).filter((n) => n.length > 0)).size;
  let doneNames = 0;

  // 작업 사전 — 배치가 진행되며 자란다 (신규 노드·병합 별칭).
  const working = new Map<string, { name: string; aliases: string[]; degree?: number }>(); // 노드명 → 노드
  const aliasOf = new Map<string, string>(); // 표기 → 노드명
  for (const node of request.dictionary.nodes) {
    working.set(node.name, { name: node.name, aliases: [...node.aliases], ...(node.degree === undefined ? {} : { degree: node.degree }) });
    for (const a of node.aliases) aliasOf.set(a, node.name);
  }
  const distinct = new Set(request.dictionary.distinctions.map(([a, b]) => pairKey(a, b)));
  const seen = new Set<string>();
  let consecutiveFailures = 0;

  for (const rawName of request.names) {
    const name = rawName.trim();
    if (name.length === 0 || seen.has(name)) continue;
    seen.add(name);
    onName?.(++doneNames, totalNames);

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
    const asNew = () => {
      result.resolutions.push({ name, node: name, via: "new" });
      working.set(name, { name, aliases: [] });
    };

    // 1.5) 지시어는 판정대에 올리지 않는다 (ISSUE-519) — 노트마다 대상이 달라 병합 판정
    //      자체가 성립하지 않는다. 해소(resolveDeixis)가 못 간 자리의 안전망: 신규 통과·엔진 0.
    if (DEICTIC_NAME_RE.test(name)) {
      asNew();
      continue;
    }

    // 2) 후보 — 분리 박제된 쌍은 후보에서 빠진다: 재병합 제안 0 (AC5). 상한(ISSUE-512)은
    //    어휘 유사 순위로 자른다 — K 이하 사전에서는 자르지 않아 종전과 같다.
    //    지시어 노드(기존 오염 그래프의 「이 티켓」류)는 누구의 병합 후보도 되지 않는다 (ISSUE-519).
    //    꼴이 다른 노드(경로↔평문)도 후보가 아니다 (ISSUE-554 — 위 CODE_SHAPE_RE).
    const nameShape = shapeOf(name);
    let candidates = [...working.values()].filter(
      (c) => !distinct.has(pairKey(name, c.name)) && !DEICTIC_NAME_RE.test(c.name) && shapeOf(c.name) === nameShape,
    );
    if (candidates.length > MAX_JUDGMENT_CANDIDATES) {
      const grams = bigramsOf(strippedOf(name));
      candidates = candidates
        .map((c) => ({ c, score: lexicalSimilarity(name, grams, c) }))
        // 동률은 차수 내림차순 (ISSUE-554) — 조망을 가장 크게 바꾸는 허브 병합이 상한에
        // 밀리지 않는다. 어휘가 순위, 차수는 동률의 보조일 뿐 — 바닥 없음 계약(#512) 무변.
        .sort(
          (a, b) =>
            b.score - a.score || (b.c.degree ?? 0) - (a.c.degree ?? 0) || a.c.name.localeCompare(b.c.name),
        )
        .slice(0, MAX_JUDGMENT_CANDIDATES)
        .map((x) => x.c);
    }
    if (candidates.length === 0) {
      asNew();
      continue;
    }
    if (consecutiveFailures >= ENGINE_FAILURE_FUSE) {
      result.failures.push({ name, reason: "엔진 연속 거절로 판정 생략 — 미병합 통과" });
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
      consecutiveFailures = 0;
    } catch (e) {
      consecutiveFailures++;
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

// ---- 지시어 해소 (ISSUE-519) ----
// 「이 티켓」류 표면명은 노트마다 다른 대상을 가리키는데 표기가 같아, 정규화가 수백 노트의
// 관계를 가짜 최대 허브 하나로 뭉쳤다(2026-11-17 첫 실물 그래프 — 최대 허브가 「이 티켓」,
// 모순 거짓 양성의 산지). 해소는 결정적이다: 지시어의 대상은 거의 언제나 그 노트 자신이
// 다루는 대상이라 노트 제목(파일명)으로 바꾼다 — 엔진 0·난수 0, 지시어 없는 입력에서는
// 무연산이라 품질 게이트 기록(#48)과도 무관하다.

export const DEICTIC_NAME_RE =
  /^(?:(?:이|그|본|해당|앞선|위|아래|지난)\s*(?:티켓|이슈|문서|노트|글|결의|판정|스펙|조문|파일|커밋|코멘트|PR)|(?:this|that|the)\s+(?:ticket|issue|note|document|doc|file|commit|comment|pr))$/i;

/** 노트 경로 → 제목 — vault 상대 경로의 파일명에서 확장자를 뗀 것. */
export function noteTitleOf(note: string): string {
  const base = note.split("/").pop() ?? note;
  return base.replace(/\.[A-Za-z0-9]+$/, "").trim();
}

/**
 * 엣지의 지시어 끝점을 그 엣지의 출처 노트 제목으로 바꾼다. 해소가 자기 지시(s===o)를
 * 만들면 그 엣지는 정보가 0 이라 버린다 — 해소가 안 닿은 엣지는 그대로다(기존 자기 지시 포함).
 * 제목 없는 노트는 해소 재료가 없어 그대로 둔다 — 병합만은 아래 블록리스트가 막는다.
 */
export function resolveDeixis<T extends { s: string; o: string }>(
  items: readonly T[],
  noteOf: (item: T) => string,
): T[] {
  const out: T[] = [];
  for (const item of items) {
    const sDeictic = DEICTIC_NAME_RE.test(item.s.trim());
    const oDeictic = DEICTIC_NAME_RE.test(item.o.trim());
    if (!sDeictic && !oDeictic) {
      out.push(item);
      continue;
    }
    const title = noteTitleOf(noteOf(item));
    if (title.length === 0) {
      out.push(item);
      continue;
    }
    const s = sDeictic ? title : item.s;
    const o = oDeictic ? title : item.o;
    if (s.trim() === o.trim()) continue;
    out.push({ ...item, s, o });
  }
  return out;
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
