// 옵시디언 투영 (F7) — 유일한 양방향 표면: 정본 → frontmatter `ontoflow` 블록, 사용자 편집 →
// 승격·정본 반영 (이슈 #10 · 스펙 AC18·AC24, 문법 정본 = 스펙 #1 「옵시디언 투영」).
// 파이프라인의 영역은 `written-by: ontoflow` 마커가 선 블록뿐 — 본문과 남의 키는 바이트 불변.
// 수집(collect.ts stripProjection)과 정확한 거울이다: 투영 → 수집하면 블록은 입력에서 사라진다.
import { parse } from "yaml";
import type { EdgeRetract, EdgeWrite, FileIo, GraphStore } from "./store.js";

export const PROJECTION_SCHEMA_VERSION = 1;
export const PROJECTION_MARKER = "written-by: ontoflow"; // 재수집 금지 마커 (스펙 AC19)

export class ProjectError extends Error {
  constructor(readonly problems: string[]) {
    super(`투영 실패:\n- ${problems.join("\n- ")}`);
    this.name = "ProjectError";
  }
}

// 투영 엣지 — `to`(목적어)는 위키링크로 선다. `s` 는 주어가 이 노트의 노드와 다를 때만 실리는
// 가산 확장이다(스펙 예시는 주어=노드인 흔한 꼴만 보인다): 출처 노트의 엣지는 임의 두 개념
// 사이에도 선다 — 주어 없는 꼴로는 그 엣지를 투영에 실을 수 없다.
export interface ProjectionEdge {
  s?: string;
  v: string;
  to: string;
  confidence: number;
  by: "auto" | "user";
  fallback: boolean;
}

export interface ProjectionData {
  node: string; // 이 파일 노드의 정규명
  aliases: string[];
  edges: ProjectionEdge[];
}

// ---- 정본 → 투영 데이터 ----

function noteName(path: string): string {
  const base = path.split("/").pop() ?? path;
  return base.replace(/\.md$/, "");
}

function all(store: GraphStore, sql: string, params: unknown[]): Record<string, unknown>[] {
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

// 이 노트가 투영에 받을 것 — 파일 노드의 정규명·별칭 + 이 노트 출처의 엣지 전부.
export function projectionDataFor(store: GraphStore, notePath: string): ProjectionData {
  const byPath = all(store, "SELECT id, name FROM nodes WHERE path = ?", [notePath])[0];
  const byName = byPath
    ? undefined
    : all(store, "SELECT id, name FROM nodes WHERE name = ?", [noteName(notePath)])[0];
  const nodeRow = byPath ?? byName;
  const node = (nodeRow?.name as string | undefined) ?? noteName(notePath);
  const aliases = nodeRow
    ? all(store, "SELECT alias FROM aliases WHERE node_id = ? ORDER BY alias", [nodeRow.id]).map(
        (r) => r.alias as string,
      )
    : [];
  const edges = all(
    store,
    `SELECT ns.name AS s, e.v AS v, no.name AS o, e.confidence AS confidence,
            e.fallback AS fallback, e.by AS by
     FROM edges e JOIN nodes ns ON ns.id = e.s JOIN nodes no ON no.id = e.o
     WHERE e.src_note = ?
     ORDER BY (ns.name = ?) DESC, ns.name, e.v, no.name`,
    [notePath, node],
  ).map((r): ProjectionEdge => {
    const s = r.s as string;
    return {
      ...(s === node ? {} : { s }),
      v: r.v as string,
      to: r.o as string,
      confidence: r.confidence as number,
      by: r.by as "auto" | "user",
      fallback: (r.fallback as number) === 1,
    };
  });
  return { node, aliases, edges };
}

// ---- 직렬화 — 결정적 출력: 같은 데이터는 같은 바이트, 재투영은 무변 저장이 된다 ----

const q = (s: string): string => JSON.stringify(s);
const link = (s: string): string => q(`[[${s}]]`);
const ident = (s: string): string => (/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(s) ? s : q(s));

export function renderProjectionBlock(data: ProjectionData): string[] {
  const lines = [
    "ontoflow:",
    `  schema: ${PROJECTION_SCHEMA_VERSION}`,
    `  ${PROJECTION_MARKER}`,
    `  node: ${q(data.node)}`,
  ];
  if (data.aliases.length > 0) lines.push(`  aliases: [${data.aliases.map(q).join(", ")}]`);
  if (data.edges.length > 0) {
    lines.push("  edges:");
    for (const e of data.edges) {
      const fields = [
        ...(e.s === undefined ? [] : [`s: ${link(e.s)}`]),
        `v: ${ident(e.v)}`,
        `to: ${link(e.to)}`,
        `confidence: ${e.confidence}`,
        `by: ${e.by}`,
        `fallback: ${e.fallback}`,
      ];
      lines.push(`    - {${fields.join(", ")}}`);
    }
  }
  return lines;
}

// ---- 본문 수술 — 파이프라인 영역(마커 블록)만 바꾸고 나머지는 바이트 불변 (AC1·AC4) ----

const FM = /^---\n([\s\S]*?)\n---(?:\n|$)/;

interface BlockSpan {
  start: number;
  end: number;
  marked: boolean;
}

function findOntoflowBlock(fmLines: string[]): BlockSpan | null {
  const start = fmLines.findIndex((l) => /^ontoflow:/.test(l));
  if (start === -1) return null;
  let end = start + 1;
  while (end < fmLines.length && /^[ \t]/.test(fmLines[end] ?? "")) end++;
  const marked = fmLines.slice(start, end).join("\n").includes(PROJECTION_MARKER);
  return { start, end, marked };
}

// 투영을 본문에 앉힌다. 빈 투영(엣지·별칭 0)은 블록을 거둔다. 사용자의 마커 없는
// `ontoflow:` 키는 사용자 입력이라 불가침이다 — 임의 보정 없이 거부한다.
export function projectContent(content: string, data: ProjectionData): string {
  const empty = data.edges.length === 0 && data.aliases.length === 0;
  const block = renderProjectionBlock(data);
  const m = FM.exec(content);

  if (!m) {
    if (empty) return content;
    return `---\n${block.join("\n")}\n---\n${content}`;
  }

  const fmLines = (m[1] ?? "").split("\n");
  const body = content.slice(m[0].length);
  const span = findOntoflowBlock(fmLines);
  if (span && !span.marked) {
    throw new ProjectError([
      "frontmatter 의 `ontoflow:` 키가 사용자 소유다(마커 없음) — 투영이 덮을 수 없다",
    ]);
  }
  if (span === null && empty) return content; // 거둘 블록도 세울 블록도 없다 — 바이트 그대로
  const kept = span ? [...fmLines.slice(0, span.start), ...fmLines.slice(span.end)] : fmLines;
  const next = empty ? kept : [...kept, ...block];
  if (next.every((l) => l.trim() === "")) return body;
  return `---\n${next.join("\n")}\n---\n${body}`;
}

// 원자 쓰기 (AC5) — 임시 파일 + rename. 실패해도 반쯤 쓰인 노트는 존재하지 않는다.
export async function projectNote(
  io: FileIo,
  vaultDir: string,
  notePath: string,
  data: ProjectionData,
): Promise<{ changed: boolean }> {
  const path = `${vaultDir}/${notePath}`;
  const content = await io.readText(path);
  if (content === null) {
    throw new ProjectError([`투영 대상 노트가 없다: ${notePath}`]);
  }
  const next = projectContent(content, data);
  if (next === content) return { changed: false }; // 무변 재투영은 쓰지 않는다 — 수집 비용 0
  const tmp = `${path}.ontoflow-tmp`;
  await io.writeText(tmp, next);
  await io.rename(tmp, path);
  return { changed: true };
}

// ---- 되읽기 — 사용자 편집의 승격 (AC3) ----

function isBy(value: unknown): value is "auto" | "user" {
  return value === "auto" || value === "user";
}

const unlink = (s: string): string => {
  const m = /^\[\[([^\]]+)\]\]$/.exec(s.trim());
  return (m ? (m[1] as string) : s).trim();
};

// 마커가 선 블록의 스키마 검증 — 위반은 임의 보정 없이 거부한다 (스펙 AC24 의 검증 자리).
export function validateProjection(doc: unknown): ProjectionData {
  const problems: string[] = [];
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
    throw new ProjectError(["ontoflow 블록이 매핑이 아니다"]);
  }
  const raw = doc as Record<string, unknown>;
  if (raw.schema !== PROJECTION_SCHEMA_VERSION) {
    problems.push(`schema 는 ${PROJECTION_SCHEMA_VERSION} 이어야 한다 (현재: ${JSON.stringify(raw.schema)})`);
  }
  if (raw["written-by"] !== "ontoflow") problems.push("written-by: ontoflow 마커가 없다");
  if (typeof raw.node !== "string" || raw.node.trim().length === 0) problems.push("node 가 비어 있다");
  const aliases: string[] = [];
  if (raw.aliases !== undefined) {
    if (!Array.isArray(raw.aliases) || raw.aliases.some((a) => typeof a !== "string")) {
      problems.push("aliases 는 문자열 목록이어야 한다");
    } else {
      aliases.push(...(raw.aliases as string[]));
    }
  }
  const edges: ProjectionEdge[] = [];
  if (raw.edges !== undefined) {
    if (!Array.isArray(raw.edges)) {
      problems.push("edges 가 목록이 아니다");
    } else {
      raw.edges.forEach((entry: unknown, i: number) => {
        if (typeof entry !== "object" || entry === null) {
          problems.push(`edges[${i}] 가 매핑이 아니다`);
          return;
        }
        const e = entry as Record<string, unknown>;
        const v = e.v;
        const to = e.to;
        const confidence = e.confidence;
        const by = e.by;
        const fallback = e.fallback;
        const s = e.s;
        if (typeof v !== "string" || v.trim().length === 0) problems.push(`edges[${i}].v 가 비어 있다`);
        if (typeof to !== "string" || unlink(to).length === 0) problems.push(`edges[${i}].to 가 비어 있다`);
        if (typeof confidence !== "number" || confidence < 0 || confidence > 1) {
          problems.push(`edges[${i}].confidence 가 [0,1] 밖이다: ${JSON.stringify(confidence)}`);
        }
        if (!isBy(by)) problems.push(`edges[${i}].by 가 auto|user 밖이다`);
        if (typeof fallback !== "boolean") problems.push(`edges[${i}].fallback 이 불리언이 아니다`);
        if (s !== undefined && (typeof s !== "string" || unlink(s).length === 0)) {
          problems.push(`edges[${i}].s 가 비어 있다`);
        }
        if (
          typeof v === "string" && v.trim().length > 0 &&
          typeof to === "string" && unlink(to).length > 0 &&
          typeof confidence === "number" && confidence >= 0 && confidence <= 1 &&
          isBy(by) && typeof fallback === "boolean" &&
          (s === undefined || (typeof s === "string" && unlink(s).length > 0))
        ) {
          edges.push({
            ...(s === undefined ? {} : { s: unlink(s) }),
            v: v.trim(),
            to: unlink(to),
            confidence,
            by,
            fallback,
          });
        }
      });
    }
  }
  if (problems.length > 0) throw new ProjectError(problems);
  return { node: (raw.node as string).trim(), aliases, edges };
}

// 노트에서 투영 블록을 읽는다 — 마커가 선 블록만. 없으면 null, 손상이면 거부.
export function parseProjection(content: string): ProjectionData | null {
  const m = FM.exec(content);
  if (!m) return null;
  const fmLines = (m[1] ?? "").split("\n");
  const span = findOntoflowBlock(fmLines);
  if (!span || !span.marked) return null;
  let doc: unknown;
  try {
    doc = parse(fmLines.slice(span.start, span.end).join("\n"));
  } catch (e) {
    throw new ProjectError([`YAML 오류: ${(e as Error).message}`]);
  }
  return validateProjection((doc as Record<string, unknown> | null)?.ontoflow);
}

// 사용자 편집의 승격 (AC3) — 지금 정본이 쓸 투영(expected)과 노트의 블록(observed)을 대조해
// 다른 것만 by:user 패치로 만든다. 사용자 편집이 정본이고 파이프라인의 입력이다 (스펙 AC18).
export function collectProjectionEdits(
  notePath: string,
  expected: ProjectionData,
  observed: ProjectionData | null,
): { add: EdgeWrite[]; retract: EdgeRetract[] } {
  const result: { add: EdgeWrite[]; retract: EdgeRetract[] } = { add: [], retract: [] };
  if (observed === null) return result; // 블록 없음 = 아직 투영 전 — 편집이 아니다

  const key = (node: string, e: ProjectionEdge) => `${e.s ?? node}\u0000${e.v}\u0000${e.to}`;
  const expectedByKey = new Map(expected.edges.map((e) => [key(expected.node, e), e]));
  const observedKeys = new Set(observed.edges.map((e) => key(observed.node, e)));

  for (const e of observed.edges) {
    const exp = expectedByKey.get(key(observed.node, e));
    const untouched =
      exp !== undefined &&
      exp.confidence === e.confidence &&
      exp.fallback === e.fallback &&
      exp.by === e.by;
    if (untouched) continue;
    result.add.push({
      s: e.s ?? observed.node,
      v: e.v,
      o: e.to,
      confidence: e.confidence,
      fallback: e.fallback,
      by: "user", // 수정·추가는 전부 승격이다
      src: { note: notePath, origin: "manual" },
    });
  }
  for (const e of expected.edges) {
    // 사용자가 지운 by:auto 항목은 철회 후보다. by:user 의 제거는 패치가 못 지우는 영역 —
    // 사용자 주도 철회는 검토 큐(S2) 몫이다.
    if (e.by === "auto" && !observedKeys.has(key(expected.node, e))) {
      result.retract.push({ s: e.s ?? expected.node, v: e.v, o: e.to, note: notePath });
    }
  }
  return result;
}
