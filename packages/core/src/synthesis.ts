// 그래프 → 정본 노트 합성 (ISSUE-59) — 「연결하면 정리돼 돌아온다」. 수집된 소스의 부분
// 그래프를 추출 엔진(gemma4 · 싱킹 off · 스키마 강제 — hub.ts 계약 그대로, 프런티어 투입
// 금지)에 태워 정리 노트 md 를 만들고, 기계 자리(기본 전용 폴더 · #31 꼴 지정 이동)에
// `written-by: ontoflow` 마커를 달아 쓴다 — 투영과 같은 의미론: 덮어쓰기 가능한 기계
// 소유물, 가져가려면 복제 (#53 Q4·Q5 결의).
//
// 소유 경계 (AC2·AC4): 쓰기 목적지는 기계 자리의 소스별 고정 경로 하나뿐이다 — 사용자
// 노트 병합·수정은 기각된 선택지(Q4 ③)라 경로 자체가 없다. 사용자가 마커를 벗긴 파일은
// 소유가 넘어간 것이라 덮어쓰지 않는다(명시 오류). 마커(frontmatter 최상위)는 #55
// isMachineAuthored 가 그대로 걸러 재수집 산출 0 이다 (AC3).
import { isMachineAuthored } from "./collect.js";
import { ENGINE_MODEL, assertEngineContract, type Engine, type EngineCall } from "./hub.js";
import { resolveHome, type FileIo, type GraphStore } from "./store.js";

export class SynthesisError extends Error {
  constructor(readonly problems: string[]) {
    super(`합성 거부:\n- ${problems.join("\n- ")}`);
    this.name = "SynthesisError";
  }
}

// ---- 소스 부분 그래프 (합성 트리거의 입력 — 수집 소스 단위) ----

export interface SynthesisEdge {
  s: string;
  v: string;
  o: string;
  confidence: number;
  fallback: boolean;
}

export interface SynthesisInput {
  sourceId: string;
  nodes: string[];
  edges: SynthesisEdge[];
}

function all(store: GraphStore, sql: string, params: unknown[]): Record<string, unknown>[] {
  const stmt = store.db.prepare(sql);
  try {
    stmt.bind(params as never);
    const rows: Record<string, unknown>[] = [];
    while (stmt.step()) rows.push(stmt.getAsObject() as Record<string, unknown>);
    return rows;
  } finally {
    stmt.free();
  }
}

/** 소스 한 곳의 부분 그래프 — 출처(src_note)가 `<소스id>:/` 접두인 엣지 전부. */
export function synthesisInputFor(store: GraphStore, sourceId: string): SynthesisInput {
  const rows = all(
    store,
    `SELECT ns.name AS s, e.v AS v, no.name AS o, e.confidence AS confidence, e.fallback AS fallback
     FROM edges e JOIN nodes ns ON ns.id = e.s JOIN nodes no ON no.id = e.o
     WHERE e.src_note LIKE ? ESCAPE '\\'
     ORDER BY ns.name, e.v, no.name`,
    [`${sourceId.replace(/[%_\\]/g, (m) => `\\${m}`)}:/%`],
  );
  const edges = rows.map(
    (r): SynthesisEdge => ({
      s: r.s as string,
      v: r.v as string,
      o: r.o as string,
      confidence: r.confidence as number,
      fallback: (r.fallback as number) === 1,
    }),
  );
  if (edges.length === 0) {
    throw new SynthesisError([`합성할 그래프가 없다 — 소스 「${sourceId}」의 수집 산출이 먼저다`]);
  }
  const nodes = [...new Set(edges.flatMap((e) => [e.s, e.o]))].sort();
  return { sourceId, nodes, edges };
}

// ---- 엔진 계약 경유 합성 판정 (AC6 — hub.ts assertEngineContract 그대로 집행) ----

/** 합성 출력 스키마 — 제목·요약·섹션(머리글+불릿). 구조는 스키마가, 어휘는 프롬프트가 강제한다. */
export const SYNTHESIS_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    title: { type: "string", minLength: 1, maxLength: 120 },
    summary: { type: "string", minLength: 1 },
    sections: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        properties: {
          heading: { type: "string", minLength: 1 },
          bullets: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
        },
        required: ["heading", "bullets"],
        additionalProperties: false,
      },
    },
  },
  required: ["title", "summary", "sections"],
  additionalProperties: false,
};

export function buildSynthesisCall(input: SynthesisInput): EngineCall {
  const lines = input.edges.map(
    (e) => `- ${e.s} —${e.v}→ ${e.o} (신뢰도 ${e.confidence}${e.fallback ? " · 폴백" : ""})`,
  );
  const prompt = [
    "당신은 지식 그래프를 사람이 읽는 정리 노트로 옮기는 서기다. 아래 관계들을 주제별로 묶어",
    "한국어 정리 노트를 만든다. 규칙: ① 노드 이름은 원문 그대로 쓰고 본문에서 [[노드 이름]]",
    "위키링크 꼴로 감싼다 ② 관계에 없는 사실을 지어내지 않는다 ③ 요약은 두세 문장이다.",
    "",
    `## 소스: ${input.sourceId}`,
    "## 관계",
    ...lines,
  ].join("\n");
  return { model: ENGINE_MODEL, think: false, temperature: 0, prompt, schema: SYNTHESIS_SCHEMA };
}

export interface SynthesisNote {
  title: string;
  /** 본문 md — frontmatter 는 쓰는 쪽(writeSynthesisNote·API 출고)이 입힌다. */
  md: string;
}

// 엔진 출력 → 결정적 md. 구조 위반은 명시 오류다 — 임의 보정 0.
export function decideSynthesis(engineText: string, input: SynthesisInput): SynthesisNote {
  let parsed: unknown;
  try {
    parsed = JSON.parse(engineText);
  } catch (e) {
    throw new SynthesisError([`엔진 출력이 JSON 이 아니다: ${(e as Error).message}`]);
  }
  const doc = parsed as { title?: unknown; summary?: unknown; sections?: unknown };
  const problems: string[] = [];
  if (typeof doc.title !== "string" || doc.title.trim() === "") problems.push("title 이 없다");
  if (typeof doc.summary !== "string" || doc.summary.trim() === "") problems.push("summary 가 없다");
  const sections = Array.isArray(doc.sections) ? (doc.sections as { heading?: unknown; bullets?: unknown }[]) : null;
  if (sections === null || sections.length === 0) problems.push("sections 가 없다");
  for (const s of sections ?? []) {
    if (typeof s.heading !== "string" || !Array.isArray(s.bullets) || s.bullets.some((b) => typeof b !== "string")) {
      problems.push("section 꼴이 어긋난다");
      break;
    }
  }
  if (problems.length > 0) throw new SynthesisError(problems);
  const body = [
    `# ${(doc.title as string).trim()}`,
    "",
    (doc.summary as string).trim(),
    ...(sections as { heading: string; bullets: string[] }[]).flatMap((s) => [
      "",
      `## ${s.heading.trim()}`,
      ...s.bullets.map((b) => `- ${b.trim()}`),
    ]),
    "",
  ].join("\n");
  return { title: (doc.title as string).trim(), md: body };
}

/** 합성 한 판 — 계약 검사(AC6)를 지나 엔진을 부르고 구조를 검증한다. 허브 면에서 돈다. */
export async function synthesizeNote(engine: Engine, input: SynthesisInput): Promise<SynthesisNote> {
  const call = buildSynthesisCall(input);
  assertEngineContract(call as unknown as Record<string, unknown>); // think off·스키마 강제 — 미명시·true 는 선다
  return decideSynthesis(await engine.complete(call), input);
}

// ---- 기계 자리 (AC1·AC2·AC4) — 기본 전용 폴더 + 지정 이동(#31 꼴) ----

/** 기본 전용 폴더 — vault 상대. #55 의 제외 목록 예가 이미 이 이름을 쓴다. */
export const SYNTHESIS_DIR = "ontoflow-notes";
export const SYNTHESIS_STATE_FILE = "synthesis.json";
export const SYNTHESIS_SCHEMA_VERSION = 1;

export interface SynthesisState {
  schema: typeof SYNTHESIS_SCHEMA_VERSION;
  /** 기계 자리 — vault 상대 경로. 수집 제외 목록(#55)에 이 값이 선다. */
  dir: string;
  /** 소스별 기계 소유물의 자리 — 덮어쓰기는 여기 적힌 경로뿐이다 (AC2·AC4). */
  notes: Record<string, { path: string }>;
}

export function emptySynthesisState(): SynthesisState {
  return { schema: SYNTHESIS_SCHEMA_VERSION, dir: SYNTHESIS_DIR, notes: {} };
}

export async function loadSynthesisState(io: FileIo, vaultDir: string): Promise<SynthesisState> {
  const home = await resolveHome(io, vaultDir);
  const text = await io.readText(`${home.dir}/${SYNTHESIS_STATE_FILE}`);
  if (text === null) return emptySynthesisState();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new SynthesisError([`${SYNTHESIS_STATE_FILE} 이 JSON 이 아니다: ${(e as Error).message}`]);
  }
  const state = parsed as SynthesisState;
  if (
    state?.schema !== SYNTHESIS_SCHEMA_VERSION ||
    typeof state.dir !== "string" ||
    state.dir.trim() === "" ||
    typeof state.notes !== "object" ||
    state.notes === null
  ) {
    throw new SynthesisError([`${SYNTHESIS_STATE_FILE} 스키마가 맞지 않는다 (기대 ${SYNTHESIS_SCHEMA_VERSION})`]);
  }
  return state;
}

export async function saveSynthesisState(io: FileIo, vaultDir: string, state: SynthesisState): Promise<void> {
  const { dir } = await resolveHome(io, vaultDir);
  await io.mkdir(dir);
  const path = `${dir}/${SYNTHESIS_STATE_FILE}`;
  const tmp = `${path}.tmp`;
  await io.writeText(tmp, JSON.stringify(state));
  await io.rename(tmp, path);
}

/** 합성 노트의 frontmatter — 최상위 `written-by: ontoflow` 가 #55 메아리 차단의 열쇠다 (AC3). */
export function renderSynthesisNote(sourceId: string, note: SynthesisNote, now: string): string {
  return `---\nwritten-by: ontoflow\nsource: ${sourceId}\nsynthesized-at: ${now}\n---\n${note.md}`;
}

/**
 * 기계 자리에 쓴다 (AC1) — 소스별 고정 경로(`<자리>/<소스id>.md`) 하나뿐이라 재합성은 자연히
 * 덮어쓰기다 (AC4). 사용자가 복제해 간 사본은 이 경로가 아니라서 무변이고, 그 자리 파일의
 * 마커를 벗겼다면 소유가 사용자로 넘어간 것 — 덮어쓰지 않고 명시 오류로 선다 (소유는 사용자).
 */
export async function writeSynthesisNote(
  io: FileIo,
  vaultDir: string,
  state: SynthesisState,
  sourceId: string,
  note: SynthesisNote,
  now: string,
): Promise<{ path: string; state: SynthesisState }> {
  const path = state.notes[sourceId]?.path ?? `${state.dir}/${sourceId}.md`;
  const existing = await io.readText(`${vaultDir}/${path}`);
  if (existing !== null && !isMachineAuthored(existing)) {
    throw new SynthesisError([
      `기계 자리의 파일에서 마커가 벗겨져 있다 — 사용자 소유로 승격된 파일은 덮어쓰지 않는다: ${path}`,
    ]);
  }
  await io.mkdir(`${vaultDir}/${state.dir}`);
  await io.writeText(`${vaultDir}/${path}`, renderSynthesisNote(sourceId, note, now));
  return { path, state: { ...state, notes: { ...state.notes, [sourceId]: { path } } } };
}

/** 자리 지정 이동 (#31 꼴) — 기계 소유물을 새 자리로 옮기고 상태를 갱신한다. */
export async function designateSynthesisDir(
  io: FileIo,
  vaultDir: string,
  state: SynthesisState,
  newDir: string,
): Promise<SynthesisState> {
  const dir = newDir.trim().replace(/^\/+|\/+$/g, "");
  if (dir === "" || dir.startsWith(".") || dir.includes("..")) {
    throw new SynthesisError([`합성 자리가 될 수 없는 경로다: ${JSON.stringify(newDir)}`]);
  }
  await io.mkdir(`${vaultDir}/${dir}`);
  const notes: SynthesisState["notes"] = {};
  for (const [sourceId, { path }] of Object.entries(state.notes)) {
    const name = path.split("/").pop() ?? `${sourceId}.md`;
    const to = `${dir}/${name}`;
    const text = await io.readText(`${vaultDir}/${path}`);
    if (text !== null) {
      await io.writeText(`${vaultDir}/${to}`, text);
      await io.remove(`${vaultDir}/${path}`);
    }
    notes[sourceId] = { path: to };
  }
  return { ...state, dir, notes };
}
