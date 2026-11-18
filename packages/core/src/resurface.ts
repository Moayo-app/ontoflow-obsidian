// 재부상 판정 (#80) — 그래프가 스스로 알려 주는 것: 모순(인과 역방향·상반 쌍·분류/구성 순환),
// 공백(출처 얇은 허브·고립 섬), 주간 델타. 전부 LLM 없는 결정론 그래프 연산이다 — 같은
// 그래프는 같은 산출(AC1). 이 모듈은 읽기 전용이다: 해소는 기계가 하지 않는다 — 산출은
// 리뷰 큐(사용자 판정 대기)와 리포트 노트뿐이고, 철회는 사용자 승인 경로만 지난다 (AC2).
import type { Registry } from "./registry.js";
import { resolveHome, type FileIo, type GraphStore } from "./store.js";

export class ResurfaceError extends Error {
  constructor(readonly problems: string[]) {
    super(`재부상 판정 실패:\n- ${problems.join("\n- ")}`);
    this.name = "ResurfaceError";
  }
}

function all(store: GraphStore, sql: string, params: unknown[] = []): Record<string, unknown>[] {
  const stmt = store.db.prepare(sql);
  const out: Record<string, unknown>[] = [];
  try {
    stmt.bind(params as never);
    while (stmt.step()) out.push(stmt.getAsObject());
  } finally {
    stmt.free();
  }
  return out;
}

export interface ResurfaceEdgeRef {
  s: string;
  v: string;
  o: string;
  note: string | null;
}

/** 판정 산출 한 건 — fingerprint 가 리뷰 큐 재노출 차단의 키다 (같은 발견은 다시 서지 않는다). */
export interface ResurfaceFinding {
  fingerprint: string;
  kind: "contradiction" | "gap";
  summary: string;
  /** 모순의 당사자 엣지 — 사용자 철회 후보. 공백은 빈 배열이다. */
  edges: ResurfaceEdgeRef[];
}

interface EdgeRow {
  s: string;
  v: string;
  o: string;
  note: string | null;
}

function edgeRows(store: GraphStore): EdgeRow[] {
  return all(
    store,
    `SELECT ns.name AS s, e.v AS v, no.name AS o, e.src_note AS note
     FROM edges e JOIN nodes ns ON ns.id = e.s JOIN nodes no ON no.id = e.o
     ORDER BY e.v, ns.name, no.name`,
  ).map((r) => ({ s: r.s as string, v: r.v as string, o: r.o as string, note: (r.note as string | null) ?? null }));
}

// ---- 모순 (AC1) ----

/** 상반 동사 쌍 — 같은 주어·목적어에 둘 다 서 있으면 모순이다 (등록부 씨앗 기준). */
const OPPOSING_VERBS: readonly [string, string][] = [["supports", "refutes"]];

export function findContradictions(store: GraphStore, registry: Registry): ResurfaceFinding[] {
  const out: ResurfaceFinding[] = [];
  const rows = edgeRows(store);
  const directional = new Set(registry.verbs.filter((v) => v.superclass !== "연관").map((v) => v.id));
  const byKey = new Map<string, EdgeRow>();
  for (const e of rows) byKey.set(`${e.v}\u0000${e.s}\u0000${e.o}`, e);

  // ① 방향 동사의 역방향 쌍 — A →v B 와 B →v A 가 함께 선다 (연관은 대칭이라 비대상).
  for (const e of rows) {
    if (!directional.has(e.v) || e.s >= e.o) continue; // 쌍은 한 번만
    const reverse = byKey.get(`${e.v}\u0000${e.o}\u0000${e.s}`);
    if (reverse === undefined) continue;
    out.push({
      fingerprint: `모순:역방향:${e.v}:${e.s}↔${e.o}`,
      kind: "contradiction",
      summary: `「${e.s}」 ↔ 「${e.o}」 가 ${e.v} 로 서로를 가리킨다 — 방향 동사의 역방향 쌍`,
      edges: [e, reverse],
    });
  }

  // ② 상반 동사 쌍 — supports 와 refutes 가 같은 방향으로 함께 선다.
  for (const [a, b] of OPPOSING_VERBS) {
    for (const e of rows) {
      if (e.v !== a) continue;
      const opposite = byKey.get(`${b}\u0000${e.s}\u0000${e.o}`);
      if (opposite === undefined) continue;
      out.push({
        fingerprint: `모순:상반:${e.s}→${e.o}`,
        kind: "contradiction",
        summary: `「${e.s}」 → 「${e.o}」 에 ${a} 와 ${b} 가 함께 서 있다 — 상반 주장`,
        edges: [e, opposite],
      });
    }
  }

  // ③ 분류·구성 순환 — is-a/part-of 류 그래프의 사이클 (길이 2 는 ①이 이미 잡는다).
  const hierVerbs = new Set(
    registry.verbs.filter((v) => v.superclass === "분류" || v.superclass === "구성").map((v) => v.id),
  );
  const next = new Map<string, EdgeRow[]>();
  for (const e of rows) {
    if (!hierVerbs.has(e.v)) continue;
    const list = next.get(e.s) ?? [];
    list.push(e);
    next.set(e.s, list);
  }
  const seenCycles = new Set<string>();
  const walk = (start: string, node: string, path: EdgeRow[]): void => {
    for (const e of next.get(node) ?? []) {
      if (e.o === start && path.length >= 2) {
        const cycle = [...path, e];
        const names = [...new Set(cycle.map((x) => x.s))].sort();
        const fp = `모순:순환:${names.join("→")}`;
        if (!seenCycles.has(fp)) {
          seenCycles.add(fp);
          out.push({
            fingerprint: fp,
            kind: "contradiction",
            summary: `분류·구성 순환이다: ${[...cycle.map((x) => x.s), start].join(" → ")}`,
            edges: cycle,
          });
        }
        continue;
      }
      if (path.length >= 8 || path.some((x) => x.s === e.o) || e.o === start) continue;
      walk(start, e.o, [...path, e]);
    }
  };
  for (const start of [...next.keys()].sort()) walk(start, start, []);
  // 지문 중복 제거 (ISSUE-520) — 같은 s·v·o 가 출처 노트별로 여러 행이라, 쌍 스캔(①②)이
  // 같은 발견을 지문까지 같게 두 번 밀었다(2026-11-17 첫 실물 — 콘솔 모순 목록의 중복 행).
  // 큐는 지문으로 재노출을 막아 멀쩡했고 화면 목록만 중복이 보였다. 첫 행이 이긴다(행 순서 결정적).
  const seenFp = new Set<string>();
  return out
    .filter((f) => !seenFp.has(f.fingerprint) && (seenFp.add(f.fingerprint), true))
    .sort((x, y) => x.fingerprint.localeCompare(y.fingerprint));
}

// ---- 공백 (AC1) ----

/** 얇은 출처 허브의 문턱 — 연결은 이만큼인데 출처 노트가 하나뿐이면 묻는다. */
export const GAP_HUB_DEGREE = 5;
/** 섬 판정 — 본 그래프가 이만큼 자랐을 때, 이 이하 크기의 성분은 섬이다. */
export const GAP_MAIN_SIZE = 5;
export const GAP_ISLAND_SIZE = 2;

export function findGaps(store: GraphStore): ResurfaceFinding[] {
  const out: ResurfaceFinding[] = [];
  const rows = edgeRows(store);

  // ① 출처 얇은 허브 — 차수 ≥ 문턱인데 출처 노트가 1개 이하.
  const degree = new Map<string, number>();
  const notes = new Map<string, Set<string>>();
  for (const e of rows) {
    for (const n of [e.s, e.o]) {
      degree.set(n, (degree.get(n) ?? 0) + 1);
      if (e.note !== null) {
        const set = notes.get(n) ?? new Set<string>();
        set.add(e.note);
        notes.set(n, set);
      }
    }
  }
  // 순서 = 신호 크기 (ISSUE-520) — 상위 N 자름(리포트·콘솔)의 분모라 순서가 의미를 진다:
  // 얇은출처 허브(차수 내림차순)가 앞, 섬(이름순)이 뒤. 결정론(AC1)은 그대로다.
  const hubs: { name: string; d: number }[] = [];
  for (const [name, d] of [...degree.entries()].sort()) {
    if (d >= GAP_HUB_DEGREE && (notes.get(name)?.size ?? 0) <= 1) hubs.push({ name, d });
  }
  hubs.sort((a, b) => b.d - a.d || a.name.localeCompare(b.name));
  for (const { name, d } of hubs) {
    out.push({
      fingerprint: `공백:얇은출처:${name}`,
      kind: "gap",
      summary: `「${name}」 은 연결이 ${d}개인데 출처 노트가 ${notes.get(name)?.size ?? 0}개뿐이다 — 이 개념을 받칠 노트가 비어 있다`,
      edges: [],
    });
  }

  // ② 고립 섬 — 본 그래프가 충분히 자란 뒤 끊겨 있는 작은 성분.
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    const p = parent.get(x) ?? x;
    if (p === x) return x;
    const root = find(p);
    parent.set(x, root);
    return root;
  };
  const union = (a: string, b: string) => parent.set(find(a), find(b));
  for (const e of rows) union(e.s, e.o);
  const components = new Map<string, string[]>();
  for (const n of degree.keys()) {
    const root = find(n);
    components.set(root, [...(components.get(root) ?? []), n]);
  }
  const sizes = [...components.values()].map((c) => c.length);
  if (Math.max(0, ...sizes) >= GAP_MAIN_SIZE) {
    for (const members of [...components.values()].sort((a, b) => (a[0] ?? "").localeCompare(b[0] ?? ""))) {
      if (members.length > GAP_ISLAND_SIZE) continue;
      const names = members.sort().join("·");
      out.push({
        fingerprint: `공백:섬:${names}`,
        kind: "gap",
        summary: `「${names}」 이(가) 본 그래프와 끊겨 있다 — 잇는 관계가 비어 있거나, 지울 찌꺼기다`,
        edges: [],
      });
    }
  }
  return out; // 신호 순서 그대로 (ISSUE-520) — 지문 가나다 정렬이 순위를 지우던 자리
}

// ---- 첫 색인 하이라이트 (이슈 #89) — 온보딩의 끝을 「이게 네 노트에서 나왔다」로.
// 각 갈래 최대 1건(모순·공백·의외의 연결), 산출 0 이면 빈 배열 — 화면은 절 자체를 그리지
// 않는다(지어내기 0, AC2). 읽기뿐이다 — 정본·큐 쓰기 0 (AC4): 확정은 검토함 몫 그대로 ----

export interface FirstIndexHighlight {
  kind: "contradiction" | "gap" | "connection";
  summary: string;
  /** 근거 노트 — 화면이 링크로 세운다. 섬 공백처럼 출처가 비면 빈 배열이다. */
  notes: string[];
}

export function firstIndexHighlights(store: GraphStore, registry: Registry): FirstIndexHighlight[] {
  const rows = edgeRows(store);
  const notesOf = new Map<string, Set<string>>();
  for (const e of rows) {
    if (e.note === null) continue;
    for (const n of [e.s, e.o]) {
      const set = notesOf.get(n) ?? new Set<string>();
      set.add(e.note);
      notesOf.set(n, set);
    }
  }

  const out: FirstIndexHighlight[] = [];

  const contradiction = findContradictions(store, registry)[0];
  if (contradiction !== undefined) {
    const notes = [...new Set(contradiction.edges.map((e) => e.note).filter((n): n is string => n !== null))].sort();
    out.push({ kind: "contradiction", summary: contradiction.summary, notes });
  }

  const gap = findGaps(store)[0];
  if (gap !== undefined) {
    // 당사자 이름은 fingerprint 에서 읽는다 — 「공백:<갈래>:<이름·이름>」 은 이 모듈이 찍는 꼴이다
    // (findGaps): 꼴이 바뀌면 여기도 같이 바뀐다.
    const members = (gap.fingerprint.split(":")[2] ?? "").split("·").filter((m) => m.length > 0);
    const notes = [...new Set(members.flatMap((m) => [...(notesOf.get(m) ?? [])]))].sort();
    out.push({ kind: "gap", summary: gap.summary, notes });
  }

  // 의외의 연결 — 서로 다른 노트를 가장 많이 잇는 노드: 잊은 연결의 재부상이 서는 자리다.
  let best: { name: string; notes: string[] } | null = null;
  for (const [name, set] of [...notesOf.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (set.size >= 2 && (best === null || set.size > best.notes.length)) {
      best = { name, notes: [...set].sort() };
    }
  }
  if (best !== null) {
    out.push({
      kind: "connection",
      summary: `「${best.name}」 이(가) 노트 ${best.notes.length}개를 잇고 있다 — 서로 다른 자리에 선 같은 개념이다`,
      notes: best.notes,
    });
  }

  return out;
}

// ---- 주간 델타 — ulid 는 시간순이라 「마지막으로 본 id」 뒤가 곧 신규다 ----

export interface ResurfaceDelta {
  nodes: number;
  edges: number;
  /** 신규 중 연결 많은 순 — 리포트의 「이번 주 자란 자리」. */
  topNodes: string[];
  /** 다음 델타의 기준점 — 이번에 본 가장 큰 id. */
  maxUlid: string | null;
}

export function deltaSince(store: GraphStore, sinceUlid: string | null): ResurfaceDelta {
  const floor = sinceUlid ?? "";
  const nodes = all(store, "SELECT id, name FROM nodes WHERE id > ? ORDER BY id", [floor]);
  const edges = all(store, "SELECT id FROM edges WHERE id > ? ORDER BY id", [floor]);
  const top = all(
    store,
    `SELECT n.name AS name,
            (SELECT COUNT(*) FROM edges e WHERE e.s = n.id OR e.o = n.id) AS degree
     FROM nodes n WHERE n.id > ? ORDER BY degree DESC, n.name LIMIT 5`,
    [floor],
  ).map((r) => r.name as string);
  const ids = [...nodes.map((r) => r.id as string), ...edges.map((r) => r.id as string)].sort();
  return {
    nodes: nodes.length,
    edges: edges.length,
    topNodes: top,
    maxUlid: ids[ids.length - 1] ?? sinceUlid,
  };
}

// ---- 리포트 — 결정론 md: LLM 은 끼지 않는다 (판정이 문장까지 만든다) ----

export interface ResurfaceReportInput {
  periodFrom: string | null;
  periodTo: string;
  delta: ResurfaceDelta;
  contradictions: readonly ResurfaceFinding[];
  gaps: readonly ResurfaceFinding[];
  /** 큐에 새로 선 건수 — 이미 본 발견(재노출 차단분)은 빼고 센 값이 들어온다. */
  newlyQueued: number;
}

/** 목록 상한 (ISSUE-520) — 리포트 한 절의 줄 수: 1,940건 전량 나열이 신호를 묻던 자리. */
export const REPORT_LIST_MAX = 20;
/** 콘솔 열람 응답의 섹션별 상한 (ISSUE-520) — 전량(실측 150KB)을 매 열람에 싣지 않는다. */
export const RESURFACE_VIEW_MAX = 50;

/** 할 말이 없으면 null — 빈 리포트를 만들지 않는다 (AC4). */
export function renderResurfaceReport(input: ResurfaceReportInput): string | null {
  const { delta } = input;
  const nothing =
    delta.nodes === 0 && delta.edges === 0 && input.contradictions.length === 0 && input.gaps.length === 0;
  if (nothing) return null;
  const lines: string[] = [];
  lines.push("# OntoFlow 주간 리포트");
  lines.push("");
  lines.push(`기간: ${input.periodFrom ?? "처음"} → ${input.periodTo}`);
  lines.push("");
  lines.push("## 이번 주 자란 것");
  lines.push("");
  lines.push(`- 새 개념 ${delta.nodes} · 새 관계 ${delta.edges}`);
  if (delta.topNodes.length > 0) {
    lines.push(`- 자란 자리: ${delta.topNodes.map((n) => `[[${n}]]`).join(" · ")}`);
  }
  if (input.contradictions.length > 0) {
    lines.push("");
    lines.push(`## 모순 — 확인 대기 ${input.contradictions.length}`); // 콘솔 리포트 헤딩과 한 단어 (ISSUE-368)
    lines.push("");
    for (const f of input.contradictions.slice(0, REPORT_LIST_MAX)) lines.push(`- ${f.summary}`);
    if (input.contradictions.length > REPORT_LIST_MAX) {
      lines.push(`- … 외 ${input.contradictions.length - REPORT_LIST_MAX}건`);
    }
  }
  if (input.gaps.length > 0) {
    lines.push("");
    lines.push(`## 비어 있는 자리 ${input.gaps.length}`);
    lines.push("");
    for (const f of input.gaps.slice(0, REPORT_LIST_MAX)) lines.push(`- ${f.summary}`);
    if (input.gaps.length > REPORT_LIST_MAX) {
      lines.push(`- … 외 ${input.gaps.length - REPORT_LIST_MAX}건`);
    }
  }
  lines.push("");
  lines.push(
    input.newlyQueued > 0
      ? `> 검토함에 새 확인 대기 ${input.newlyQueued}건이 섰습니다 — 해소는 기계가 하지 않습니다, 판정은 당신 몫입니다.`
      : "> 새 확인 대기는 없습니다.",
  );
  return lines.join("\n");
}

// ---- 상태 — 그래프 홈의 resurface.json (collect.json 과 같은 규율) ----

export const RESURFACE_STATE_FILE = "resurface.json";
export const RESURFACE_SCHEMA_VERSION = 1;
/** 주기 — 7일. 수집 사이클에 편승해 「지났으면 돈다」 꼴이다 (크론 아님). */
export const RESURFACE_PERIOD_MS = 7 * 24 * 60 * 60 * 1000;
/** 리포트 노트의 고정 키 — 합성 기계 자리 의미론(#59)을 그대로 탄다. */
export const RESURFACE_NOTE_ID = "주간-리포트";

export interface ResurfaceState {
  schema: typeof RESURFACE_SCHEMA_VERSION;
  lastReportAt: string | null;
  lastUlid: string | null;
}

export function emptyResurfaceState(): ResurfaceState {
  return { schema: RESURFACE_SCHEMA_VERSION, lastReportAt: null, lastUlid: null };
}

export function isReportDue(state: ResurfaceState, now: string): boolean {
  if (state.lastReportAt === null) return true;
  return new Date(now).getTime() - new Date(state.lastReportAt).getTime() >= RESURFACE_PERIOD_MS;
}

export async function loadResurfaceState(io: FileIo, vaultDir: string): Promise<ResurfaceState> {
  const home = await resolveHome(io, vaultDir);
  const text = await io.readText(`${home.dir}/${RESURFACE_STATE_FILE}`);
  if (text === null) return emptyResurfaceState();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new ResurfaceError([`${RESURFACE_STATE_FILE} 이 JSON 이 아니다: ${(e as Error).message}`]);
  }
  const state = parsed as ResurfaceState;
  if (state?.schema !== RESURFACE_SCHEMA_VERSION) {
    throw new ResurfaceError([`${RESURFACE_STATE_FILE} 스키마가 맞지 않는다 (기대 ${RESURFACE_SCHEMA_VERSION})`]);
  }
  return state;
}

export async function saveResurfaceState(io: FileIo, vaultDir: string, state: ResurfaceState): Promise<void> {
  const { dir } = await resolveHome(io, vaultDir);
  await io.mkdir(dir);
  const path = `${dir}/${RESURFACE_STATE_FILE}`;
  const tmp = `${path}.tmp`;
  await io.writeText(tmp, JSON.stringify(state));
  await io.rename(tmp, path);
}
