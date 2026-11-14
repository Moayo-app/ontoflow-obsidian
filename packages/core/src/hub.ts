// 허브 추출 (F2) · 재색인 (F5) — 허브는 무상태: 모든 요청이 자기완결이다 (이슈 #8 · 스펙 API1·API2).
// 엔진 계약: think:false · temperature 0 · output json_schema(동사 enum = 요청에 실린 등록부).
// 실제 HTTP 층·서빙 스택은 별도 — 여기는 요청 검증·프롬프트·출력 검증·패치 조립의 도메인 로직이다.
import {
  FALLBACK_VERB_ID,
  SUPERCLASSES,
  verbEnum,
  type Observation,
  type Registry,
  type Superclass,
} from "./registry.js";
import type { EdgeRetract, EdgeWrite } from "./store.js";

export const ENGINE_MODEL = "gemma4:26b-a4b"; // moayo-hq#270 결의 1
// ⭕ p2 (2026-11-07, #245 AC1 — Henry 승격 판정): p1 이 실서빙 게이트에서 정밀도 0.667 로
//    미달했고, A/B 4라운드(12후보)의 우승 조합 r4(ab1·ab2·fb2·ex — 정밀도 0.851 · 재현율
//    0.909 · 오귀속 0)를 rulesBlock 에 통합했다. 측정 방법·전 후보 성적은 #245 기록.
export const PROMPT_VERSION = "p2"; // 현행 1본 — A/B 측정은 품질 게이트 하네스 몫
export const MAX_ENGINE_RETRIES = 2; // 스키마 위반 출력의 재시도 상한 (AC8)
// 분할 예산 기본값 — 서빙 설정값으로 덮어쓴다. 단위는 추정 토큰 (estimateTokens).
export const DEFAULT_CONTEXT_BUDGET = 6000;

export class HubError extends Error {
  constructor(
    readonly status: number,
    readonly problems: string[],
  ) {
    super(`허브 거부 (${status}):\n- ${problems.join("\n- ")}`);
    this.name = "HubError";
  }
}

// ---- 엔진 계약 (AC7) ----

export interface EngineCall {
  model: string;
  think: false; // 계약 — 켜 두면 출력 예산을 싱킹이 소진한다 (#270 운영 발견 1)
  temperature: 0;
  prompt: string;
  schema: Record<string, unknown>; // output json_schema — 동사 enum 포함
}

export interface Engine {
  complete(call: EngineCall): Promise<string>;
}

// 싱킹 off 가 계약이다 — 미명시·true 는 거부한다 (AC7).
export function assertEngineContract(call: Record<string, unknown>): asserts call is EngineCall & Record<string, unknown> {
  const problems: string[] = [];
  if (call.think !== false) {
    problems.push(`think 는 명시적 false 여야 합니다 (현재: ${JSON.stringify(call.think)})`);
  }
  if (call.temperature !== 0) {
    problems.push(`temperature 는 0 이어야 합니다 (현재: ${JSON.stringify(call.temperature)})`);
  }
  if (typeof call.schema !== "object" || call.schema === null) {
    problems.push("output json_schema 가 없습니다 — 스키마 강제가 계약입니다");
  }
  if (problems.length > 0) throw new HubError(400, problems);
}

// 엔진 출력 스키마 — 동사 enum = 요청의 등록부 (AC1·AC2 의 구조 보장 자리).
export function engineOutputSchema(registry: Registry): Record<string, unknown> {
  const verbs = verbEnum(registry);
  const edge = {
    type: "object",
    properties: {
      s: { type: "string", minLength: 1 },
      v: { type: "string", enum: verbs },
      o: { type: "string", minLength: 1 },
      confidence: { type: "number", minimum: 0, maximum: 1 },
      fallback: { type: "boolean" },
    },
    required: ["s", "v", "o", "confidence", "fallback"],
    additionalProperties: false,
  };
  return {
    type: "object",
    properties: {
      edges: { type: "array", items: edge },
      retracts: {
        type: "array",
        items: {
          type: "object",
          properties: {
            s: { type: "string", minLength: 1 },
            v: { type: "string", enum: verbs },
            o: { type: "string", minLength: 1 },
          },
          required: ["s", "v", "o"],
          additionalProperties: false,
        },
      },
      proposals: {
        type: "array",
        items: {
          type: "object",
          properties: {
            verbRaw: { type: "string", minLength: 1 },
            superclass: { type: "string", enum: [...SUPERCLASSES] },
            s: { type: "string" },
            o: { type: "string" },
          },
          required: ["verbRaw", "superclass"],
          additionalProperties: false,
        },
      },
    },
    required: ["edges", "retracts", "proposals"],
    additionalProperties: false,
  };
}

export function buildEngineCall(prompt: string, registry: Registry): EngineCall {
  return {
    model: ENGINE_MODEL,
    think: false,
    temperature: 0,
    prompt,
    schema: engineOutputSchema(registry),
  };
}

// ---- 엔진 출력 검증 (AC8) — 스키마 강제를 믿지 않고 허브가 재검증한다 ----

export interface RawEdge {
  s: string;
  v: string;
  o: string;
  confidence: number;
  fallback: boolean;
}

export interface RawRetract {
  s: string;
  v: string;
  o: string;
}

export interface RawProposal {
  verbRaw: string;
  superclass: Superclass;
}

export interface EngineOutput {
  edges: RawEdge[];
  retracts: RawRetract[];
  proposals: RawProposal[];
}

function isSuperclass(value: unknown): value is Superclass {
  return typeof value === "string" && (SUPERCLASSES as readonly string[]).includes(value);
}

// ---- 연락처 차단 (ISSUE-242 AC2 · #221 A6) — 간접수집 고지 비대행 선언의 전제 ----
//
// 구조가 절반을 진다: 추출 스키마(engineOutputSchema)에는 속성 자리가 아예 없다
// (additionalProperties: false — 연락처가 「속성으로 파싱」될 자리가 없다). 나머지 절반이
// 여기다 — 연락처가 **노드 이름**(s·o)으로 새는 뒷문: 이메일·전화번호 꼴의 이름을 단 엣지는
// 산출에서 떨어진다(기각이 아니라 필터 — 한 문장 때문에 노트 전체가 재시도 루프에 갇히지 않게).
// 전화번호 꼴은 보수적이다(한국 0 접두·국제 + 접두) — 연도 범위(1914-1918)류 오탐을 피한다.

const CONTACT_EMAIL_SHAPE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
// 두 꼴 — 국내(0 접두)와 국제(+ 접두, 0 탈락 포함). 둘 다 구분자 있는 7자리 이상만이라
// 연도 범위(1914-1918)·포트 번호 같은 수치 이름은 걸리지 않는다.
const CONTACT_PHONE_SHAPE = /(?:\+\d{1,3}[ -]?\d{1,2}[ -]?\d{3,4}[ -]?\d{4})|(?:0\d{1,2}[ -]?\d{3,4}[ -]?\d{4})/;

export function isContactShaped(name: string): boolean {
  return CONTACT_EMAIL_SHAPE.test(name) || CONTACT_PHONE_SHAPE.test(name);
}

// 위반 출력은 기각된다 — 정본 도달 차단 (AC8). 호출 측이 재시도를 진다.
export function parseEngineOutput(text: string, registry: Registry): EngineOutput {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    throw new HubError(422, [`JSON 오류: ${(e as Error).message}`]);
  }
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
    throw new HubError(422, ["출력 최상위가 객체가 아닙니다"]);
  }
  const raw = doc as Record<string, unknown>;
  const verbs = new Set(verbEnum(registry));
  const problems: string[] = [];

  const edges: RawEdge[] = [];
  if (!Array.isArray(raw.edges)) {
    problems.push("edges 가 배열이 아닙니다");
  } else {
    raw.edges.forEach((e: unknown, i: number) => {
      if (typeof e !== "object" || e === null) {
        problems.push(`edges[${i}] 가 객체가 아닙니다`);
        return;
      }
      const { s, v, o, confidence, fallback } = e as Record<string, unknown>;
      if (typeof s !== "string" || s.trim().length === 0) problems.push(`edges[${i}].s 가 비어 있습니다`);
      if (typeof o !== "string" || o.trim().length === 0) problems.push(`edges[${i}].o 가 비어 있습니다`);
      if (typeof v !== "string" || !verbs.has(v)) {
        problems.push(`edges[${i}].v 가 등록부 밖입니다: ${JSON.stringify(v)} — 자유 문자열 동사 0`);
      }
      if (typeof confidence !== "number" || confidence < 0 || confidence > 1) {
        problems.push(`edges[${i}].confidence 가 [0,1] 밖입니다: ${JSON.stringify(confidence)}`);
      }
      if (typeof fallback !== "boolean") {
        problems.push(`edges[${i}].fallback 이 불리언이 아닙니다`);
      } else if (fallback && v !== FALLBACK_VERB_ID) {
        problems.push(`edges[${i}] 폴백 표시는 ${FALLBACK_VERB_ID} 에만 섭니다 (현재 동사: ${JSON.stringify(v)})`);
      }
      if (
        typeof s === "string" && s.trim().length > 0 &&
        typeof o === "string" && o.trim().length > 0 &&
        typeof v === "string" && verbs.has(v) &&
        typeof confidence === "number" && confidence >= 0 && confidence <= 1 &&
        typeof fallback === "boolean" && (!fallback || v === FALLBACK_VERB_ID)
      ) {
        // 연락처 차단 (ISSUE-242 AC2 · A6) — 이메일·전화번호 꼴 이름의 엣지는 산출 0.
        if (isContactShaped(s) || isContactShaped(o)) return;
        edges.push({ s: s.trim(), v, o: o.trim(), confidence, fallback });
      }
    });
  }

  const retracts: RawRetract[] = [];
  if (!Array.isArray(raw.retracts)) {
    problems.push("retracts 가 배열이 아닙니다");
  } else {
    raw.retracts.forEach((r: unknown, i: number) => {
      if (typeof r !== "object" || r === null) {
        problems.push(`retracts[${i}] 가 객체가 아닙니다`);
        return;
      }
      const { s, v, o } = r as Record<string, unknown>;
      if (
        typeof s === "string" && s.trim().length > 0 &&
        typeof v === "string" && verbs.has(v) &&
        typeof o === "string" && o.trim().length > 0
      ) {
        retracts.push({ s: s.trim(), v, o: o.trim() });
      } else {
        problems.push(`retracts[${i}] 가 {s, v∈등록부, o} 계약을 어깁니다`);
      }
    });
  }

  const proposals: RawProposal[] = [];
  if (!Array.isArray(raw.proposals)) {
    problems.push("proposals 가 배열이 아닙니다");
  } else {
    raw.proposals.forEach((p: unknown, i: number) => {
      if (typeof p !== "object" || p === null) {
        problems.push(`proposals[${i}] 가 객체가 아닙니다`);
        return;
      }
      const { verbRaw, superclass } = p as Record<string, unknown>;
      if (typeof verbRaw === "string" && verbRaw.trim().length > 0 && isSuperclass(superclass)) {
        proposals.push({ verbRaw: verbRaw.trim(), superclass });
      } else {
        problems.push(`proposals[${i}] 가 {verbRaw, superclass∈상위분류} 계약을 어깁니다`);
      }
    });
  }

  if (problems.length > 0) throw new HubError(422, problems);
  return { edges, retracts, proposals };
}

// ---- 분할 처리 (AC11) ----

// 거친 토큰 근사 — 보수적으로 자수를 쓴다. 정밀 보정은 서빙 설정값(budget)의 몫.
export function estimateTokens(text: string): number {
  return text.length;
}

class SplitError extends Error {}

// unified diff 를 헝크 경계로 예산 안에 나눈다. 헝크 하나가 예산을 넘으면 분할 실패.
export function splitDiff(diff: string, budget: number): string[] {
  if (estimateTokens(diff) <= budget) return [diff];
  const lines = diff.split("\n");
  const firstHunk = lines.findIndex((l) => l.startsWith("@@"));
  if (firstHunk < 0) throw new SplitError("헝크 경계가 없어 나눌 수 없다");
  const header = lines.slice(0, firstHunk).join("\n");
  const hunks: string[] = [];
  let current: string | null = null;
  for (const line of lines.slice(firstHunk)) {
    if (line.startsWith("@@")) {
      if (current !== null) hunks.push(current);
      current = line;
    } else if (current !== null) {
      current += `\n${line}`;
    }
  }
  if (current !== null) hunks.push(current);
  return packUnits(hunks, header, budget, "헝크");
}

// 전문을 빈 줄(문단) 경계로 예산 안에 나눈다. 문단 하나가 예산을 넘으면 분할 실패.
export function splitBody(body: string, budget: number): string[] {
  if (estimateTokens(body) <= budget) return [body];
  const paragraphs = body.split(/\n{2,}/).filter((p) => p.trim().length > 0);
  return packUnits(paragraphs, "", budget, "문단");
}

function packUnits(units: string[], header: string, budget: number, unitName: string): string[] {
  const chunks: string[] = [];
  let current = "";
  for (const unit of units) {
    const alone = header.length > 0 ? `${header}\n${unit}` : unit;
    if (estimateTokens(alone) > budget) {
      throw new SplitError(`${unitName} 하나가 예산(${budget})을 넘는다 — 더 나눌 수 없다`);
    }
    const merged = current.length === 0 ? alone : `${current}\n\n${unit}`;
    if (estimateTokens(merged) > budget) {
      chunks.push(current);
      current = alone;
    } else {
      current = merged;
    }
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

// ---- 프롬프트 — 현행 1본 (PROMPT_VERSION). A/B 후보는 moayo-hq#270, 측정은 하네스 ----

function registryBlock(registry: Registry): string {
  const verbs = registry.verbs
    .map((v) => `- ${v.id} (${v.superclass} · ${v.label})`)
    .join("\n");
  return `동사 등록부 v${registry.version} — 이 목록 밖 동사는 쓰지 않는다:\n${verbs}`;
}

// 추출 규칙 — AC2~AC6 의 명문. 구조는 json_schema 가, 행동은 이 규칙이 강제한다.
function rulesBlock(kind: "incremental" | "reindex"): string {
  const rules = [
    "명시된 관계 서술만 추출한다 — 암시·추론만으로 성립하는 관계는 내지 않는다.",
    "관계 서술이 없으면 edges 는 빈 배열이다 — 억지 트리플을 만들지 않는다.",
    "무관 진술(「A 는 B 와 무관하다」)은 관계의 부재다 — refutes 엣지로 바꾸지 않는다.",
    `등록부에 맞는 동사가 없는 관계 서술은 ${FALLBACK_VERB_ID} 에 fallback: true 로 내려앉고, proposals 에 동사 원문(verbRaw)과 상위분류 추천을 남긴다.`,
    "헤지 서술(「~로 보인다」 「~일 수 있다」)은 confidence 를 1.0 미만으로 낮춰 표현한다.",
    kind === "incremental"
      ? "디프가 더한 서술의 관계만 edges 에, 디프가 지운 서술의 관계만 retracts 에 담는다 — 이미 알려진 엣지와 디프 밖 문단의 관계는 다시 내지 않는다."
      : "전문에서 edges 만 낸다 — retracts 는 항상 빈 배열이다.",
  ];
  return `규칙:\n${rules.map((r, i) => `${i + 1}. ${r}`).join("\n")}`;
}

/**
 * p2 의 네 줄 (#245 AC1) — A/B 4라운드 우승 조합 r4(ab1 · ab2 · fb2 · ex).
 *
 * ⚠️ **자리가 측정의 일부다.** A/B 하네스는 이 넷을 프롬프트 **맨 끝**(디프·본문 뒤)에
 *    별도 「추가 규칙:」 블록으로 붙여 쟀다 — 그 꼴로 정밀도 0.851 이었다. 같은 문장을
 *    `rulesBlock` 안에 7~10번으로 녹여 보니 **실측 0.76 으로 떨어졌다**(2026-11-07 기록
 *    실행). 문장은 같아도 자리가 다르면 다른 물건이다: 그래서 **측정된 꼴 그대로** 맨 끝에
 *    선다. 자리를 옮기려면 먼저 그 꼴로 다시 측정한다.
 */
function extraRulesBlock(): string {
  const rules = [
    "instance-of 의 목적어는 범주 이름 하나다 — 서술구·정의문을 목적어로 쓰지 않고, 인물을 사상·학파에 instance-of 로 걸지 않는다(그런 관계는 related-to 다).",
    "refutes 는 증거·반론이 주어(s)에 선다 — 반박당하는 쪽이 목적어(o)다.",
    "fallback 판정: 노트의 서술이 등록부 다섯 동사의 뜻(분류·구성·인과·순차·연관) 중 하나에 들어맞으면 그 동사에 fallback: false 다. 노트가 등록부에 없는 구체적 동사(예: 악화시킨다·의심한다·치료한다)로 서술했을 때만 related-to 에 fallback: true 로 내려앉고 proposals 에 그 동사 원문을 남긴다.",
    "한 문장 안에 주어와 목적어가 함께 서술된 관계만 추출한다 — 노트 전체의 요지·분류·평가를 새 관계로 만들지 않고, 제목·주제에서 유도한 instance-of·is-a 를 내지 않는다.",
  ];
  return `추가 규칙:\n${rules.map((r, i) => `${i + 1}. ${r}`).join("\n")}`;
}

function contextBlock(context: readonly ContextEdge[]): string {
  if (context.length === 0) return "이미 알려진 엣지: 없음";
  const lines = context.map((e) => `- (${e.s}) -[${e.v}]-> (${e.o})`).join("\n");
  return `이미 알려진 엣지 (이 노트 출처):\n${lines}`;
}

export function buildIncrementalPrompt(
  note: string,
  diffChunk: string,
  context: readonly ContextEdge[],
  registry: Registry,
): string {
  return [
    "너는 노트의 관계 서술을 닫힌 동사의 그래프로 추출한다. 출력은 JSON 하나 — {edges, retracts, proposals}.",
    registryBlock(registry),
    rulesBlock("incremental"),
    contextBlock(context),
    `대상 노트: ${note}`,
    `디프:\n${diffChunk}`,
    extraRulesBlock(), // ⚠️ 맨 끝 — 측정된 자리다 (extraRulesBlock 머리주석)
  ].join("\n\n");
}

export function buildReindexPrompt(note: string, bodyChunk: string, registry: Registry): string {
  return [
    "너는 노트의 관계 서술을 닫힌 동사의 그래프로 추출한다. 출력은 JSON 하나 — {edges, retracts, proposals}.",
    registryBlock(registry),
    rulesBlock("reindex"),
    `대상 노트: ${note}`,
    `본문:\n${bodyChunk}`,
    extraRulesBlock(), // ⚠️ 맨 끝 — 측정된 자리다 (extraRulesBlock 머리주석)
  ].join("\n\n");
}

// ---- API1 — POST /v1/extract/incremental ----

// 그래프 문맥 — 변경 노트 출처의 기존 엣지. 허브는 저장하지 않으므로 요청에 실려 온다.
export interface ContextEdge {
  s: string;
  v: string;
  o: string;
  note: string;
}

export interface IncrementalChange {
  note: string; // vault 상대 경로
  diff: string; // 수집(F1)이 세운 unified diff
}

export interface IncrementalRequest {
  registry: Registry;
  changes: IncrementalChange[];
  context: ContextEdge[];
  budget?: number; // 엔진 컨텍스트 예산 (서빙 설정값) — 추정 토큰
}

export interface HeldNote {
  note: string;
  reason: string;
}

export interface IncrementalResponse {
  add: EdgeWrite[];
  retract: EdgeRetract[];
  proposals: Observation[];
  held: HeldNote[]; // 보류·통지 대상 — 파이프라인 전체 중단 0 (AC11)
}

// 허브는 등록부를 저장하지 않는다 — 안 실려 오면 400 (AC12, 무상태의 집행).
function validateRegistry(registry: Registry | undefined): asserts registry is Registry {
  const problems: string[] = [];
  if (!registry || !Array.isArray(registry.verbs) || registry.verbs.length === 0) {
    problems.push("등록부가 실리지 않았습니다 — 허브는 무상태라 요청마다 실려야 합니다");
  } else if (!registry.verbs.some((v) => v.id === FALLBACK_VERB_ID)) {
    problems.push(`등록부에 폴백 동사 ${FALLBACK_VERB_ID} 가 없습니다 — 폴백이 내려앉을 자리가 없습니다`);
  }
  if (problems.length > 0) throw new HubError(400, problems);
}

// 스키마 위반 출력은 기각·재시도, 소진되면 호출 측이 그 노트만 보류한다 (AC8·AC11).
async function callEngine(engine: Engine, prompt: string, registry: Registry): Promise<EngineOutput> {
  const call = buildEngineCall(prompt, registry);
  assertEngineContract(call as unknown as Record<string, unknown>);
  const problems: string[] = [];
  for (let attempt = 0; attempt <= MAX_ENGINE_RETRIES; attempt += 1) {
    const text = await engine.complete(call);
    try {
      return parseEngineOutput(text, registry);
    } catch (e) {
      if (!(e instanceof HubError)) throw e;
      problems.push(`시도 ${attempt + 1}: ${e.problems.join(" · ")}`);
    }
  }
  throw new HubError(422, problems);
}

const edgeKey = (e: { s: string; v: string; o: string }) => `${e.s}\u0000${e.v}\u0000${e.o}`;

export async function extractIncremental(
  engine: Engine,
  request: IncrementalRequest,
): Promise<IncrementalResponse> {
  validateRegistry(request.registry);
  const budget = request.budget ?? DEFAULT_CONTEXT_BUDGET;
  const response: IncrementalResponse = { add: [], retract: [], proposals: [], held: [] };

  for (const change of request.changes ?? []) {
    const context = (request.context ?? []).filter((e) => e.note === change.note);
    let chunks: string[];
    try {
      chunks = splitDiff(change.diff, budget);
    } catch (e) {
      response.held.push({ note: change.note, reason: (e as Error).message });
      continue;
    }

    const outputs: EngineOutput[] = [];
    try {
      for (const chunk of chunks) {
        outputs.push(
          await callEngine(engine, buildIncrementalPrompt(change.note, chunk, context, request.registry), request.registry),
        );
      }
    } catch (e) {
      if (!(e instanceof HubError)) throw e;
      // 그 노트만 보류 — 다른 노트의 처리는 계속된다 (AC8·AC11)
      response.held.push({ note: change.note, reason: e.problems.join(" · ") });
      continue;
    }

    mergeOutputs(response, outputs, change.note, context);
  }
  return response;
}

// 청크 산출 병합 — 중복 제거 + 이미 알려진 엣지 걸러내기(churn 0, AC9).
function mergeOutputs(
  response: IncrementalResponse,
  outputs: EngineOutput[],
  note: string,
  context: readonly ContextEdge[],
): void {
  const known = new Set(context.map(edgeKey));
  const seenAdds = new Set(response.add.map(edgeKey));
  const seenRetracts = new Set(response.retract.map(edgeKey));
  const seenProposals = new Set(response.proposals.map((p) => `${p.verbRaw}\u0000${p.note}`));

  for (const out of outputs) {
    for (const e of out.edges) {
      const key = edgeKey(e);
      if (known.has(key) || seenAdds.has(key)) continue;
      seenAdds.add(key);
      response.add.push({
        s: e.s,
        v: e.v,
        o: e.o,
        confidence: e.confidence,
        fallback: e.fallback,
        by: "auto",
        src: { note, origin: "extract" },
      });
    }
    for (const r of out.retracts) {
      const key = edgeKey(r);
      if (seenRetracts.has(key)) continue;
      seenRetracts.add(key);
      response.retract.push({ s: r.s, v: r.v, o: r.o, note });
    }
    for (const p of out.proposals) {
      const key = `${p.verbRaw}\u0000${note}`;
      if (seenProposals.has(key)) continue;
      seenProposals.add(key);
      response.proposals.push({ verbRaw: p.verbRaw, superclassHint: p.superclass, note });
    }
  }
}

// ---- API2 — POST /v1/extract/reindex ----

export interface ReindexNote {
  note: string;
  body: string; // 전문 — 수집(F1)과 같은 입력 규칙(투영 제외)을 플러그인이 이미 적용했다
}

export interface ReindexRequest {
  registry: Registry;
  notes: ReindexNote[];
  budget?: number;
}

export interface ReindexResponse {
  edges: EdgeWrite[]; // 전체 재생성 산출물 — 원자 교체(rebuild)는 정본 쪽이 진다 (AC10)
  proposals: Observation[];
  held: HeldNote[];
  versions: { registry: number; prompt: string }; // meta 기록용 버전 메타
}

export async function extractReindex(engine: Engine, request: ReindexRequest): Promise<ReindexResponse> {
  validateRegistry(request.registry);
  const budget = request.budget ?? DEFAULT_CONTEXT_BUDGET;
  const response: ReindexResponse = {
    edges: [],
    proposals: [],
    held: [],
    versions: { registry: request.registry.version, prompt: PROMPT_VERSION },
  };
  const seenEdges = new Set<string>();
  const seenProposals = new Set<string>();

  for (const { note, body } of request.notes ?? []) {
    let chunks: string[];
    try {
      chunks = splitBody(body, budget);
    } catch (e) {
      response.held.push({ note, reason: (e as Error).message });
      continue;
    }

    const outputs: EngineOutput[] = [];
    try {
      for (const chunk of chunks) {
        outputs.push(
          await callEngine(engine, buildReindexPrompt(note, chunk, request.registry), request.registry),
        );
      }
    } catch (e) {
      if (!(e instanceof HubError)) throw e;
      response.held.push({ note, reason: e.problems.join(" · ") });
      continue;
    }

    for (const out of outputs) {
      // 재색인에 철회는 없다 — 전체 재생성이므로 엔진의 retracts 는 버린다
      for (const e of out.edges) {
        const key = `${note}\u0000${edgeKey(e)}`;
        if (seenEdges.has(key)) continue;
        seenEdges.add(key);
        response.edges.push({
          s: e.s,
          v: e.v,
          o: e.o,
          confidence: e.confidence,
          fallback: e.fallback,
          by: "auto",
          src: { note, origin: "extract" },
        });
      }
      for (const p of out.proposals) {
        const key = `${p.verbRaw}\u0000${note}`;
        if (seenProposals.has(key)) continue;
        seenProposals.add(key);
        response.proposals.push({ verbRaw: p.verbRaw, superclassHint: p.superclass, note });
      }
    }
  }
  return response;
}
