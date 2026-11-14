// 내보내기 (F8) — 플러그인 로컬 생성: 서버 호출 0 · 무료 · 회원 게이트 0 (이슈 #11 · 스펙
// AC25·AC26, #269 기대선 「데이터는 항상 로컬·무료로 나간다」).
// JSON-LD 는 자체 어휘 + `@context` 표준 매핑의 평문 트리플(OWL 미채택 — #271 결의 11),
// 엣지 메타(superclass·confidence·fallback·by)는 GraphML 속성이 싣는다.
import type { Registry } from "./registry.js";
import { StoreError, type GraphStore } from "./store.js";

// `of:` 네임스페이스 자리표시 — 단일 상수 (이슈 AC5). `.invalid` 는 예약 TLD 라 실제 도메인과
// 충돌할 수 없다. 도메인 확정(moayo-hq#273 재론, 첫 공개 출고 직전) 시 이 한 자리만 바꾼다.
export const OF_NAMESPACE = "https://ontoflow.invalid/vocab#";

// 스펙 「JSON-LD @context」 — 있는 표준만 매핑, 나머지(causes·precedes·커스텀)는 자체 어휘.
const STANDARD_TERMS: Record<string, string> = {
  "is-a": "skos:broader",
  "instance-of": "rdf:type",
  "part-of": "schema:isPartOf",
  "related-to": "skos:related",
  supports: "cito:supports",
  refutes: "cito:disputes",
};

const PREFIXES = {
  of: OF_NAMESPACE,
  skos: "http://www.w3.org/2004/02/skos/core#",
  schema: "https://schema.org/",
  cito: "http://purl.org/spar/cito/",
  rdf: "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
} as const;

interface NodeRow {
  id: string;
  name: string;
  kind: string;
  aliases: string[];
}

interface EdgeRow {
  id: string;
  s: string; // 노드 id
  v: string;
  o: string; // 노드 id
  confidence: number;
  fallback: boolean;
  by: string;
}

function all(store: GraphStore, sql: string): Record<string, unknown>[] {
  const stmt = store.db.prepare(sql);
  const out: Record<string, unknown>[] = [];
  try {
    while (stmt.step()) out.push(stmt.getAsObject());
  } finally {
    stmt.free();
  }
  return out;
}

// 정본 스냅샷 — 결정적 순서(이름순·엣지 id 순): 같은 정본은 같은 바이트로 나간다.
function snapshot(store: GraphStore): { nodes: NodeRow[]; edges: EdgeRow[] } {
  const nodes = all(store, "SELECT id, name, kind FROM nodes ORDER BY name").map(
    (r): NodeRow => ({
      id: r.id as string,
      name: r.name as string,
      kind: r.kind as string,
      aliases: [],
    }),
  );
  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (const r of all(store, "SELECT node_id, alias FROM aliases ORDER BY alias")) {
    byId.get(r.node_id as string)?.aliases.push(r.alias as string);
  }
  const edges = all(
    store,
    "SELECT id, s, v, o, confidence, fallback, by FROM edges ORDER BY id",
  ).map(
    (r): EdgeRow => ({
      id: r.id as string,
      s: r.s as string,
      v: r.v as string,
      o: r.o as string,
      confidence: r.confidence as number,
      fallback: (r.fallback as number) === 1,
      by: r.by as string,
    }),
  );
  return { nodes, edges };
}

// 정본과 등록부가 갈라졌다면(참조 동사 실종) 내보내기는 보고하고 선다 — 임의 보정 0.
function superclassOf(registry: Registry, verbs: Set<string>): Map<string, string> {
  const map = new Map(registry.verbs.map((v) => [v.id, v.superclass as string]));
  const missing = [...verbs].filter((v) => !map.has(v));
  if (missing.length > 0) {
    throw new StoreError(missing.map((v) => `정본의 동사가 등록부에 없다: ${v}`));
  }
  return map;
}

// ---- JSON-LD — 자체 어휘 + @context 매핑, owl: 항 0 (AC2) ----

export function exportJsonLd(store: GraphStore, registry: Registry): string {
  const { nodes, edges } = snapshot(store);
  superclassOf(registry, new Set(edges.map((e) => e.v))); // 등록부 일치 검사만

  const context: Record<string, unknown> = {
    ...PREFIXES,
    name: "schema:name",
    alternateName: "schema:alternateName",
  };
  const verbIds = [...new Set([...registry.verbs.map((v) => v.id)])].sort();
  for (const v of verbIds) {
    context[v] = { "@id": STANDARD_TERMS[v] ?? `of:${v}`, "@type": "@id" };
  }

  const iri = (nodeId: string) => `of:node/${nodeId}`;
  const nameOf = new Map(nodes.map((n) => [n.id, n.name]));
  const graph = nodes.map((n) => {
    const entry: Record<string, unknown> = { "@id": iri(n.id), name: n.name };
    if (n.aliases.length > 0) entry.alternateName = n.aliases;
    const outgoing = edges.filter((e) => e.s === n.id);
    const byVerb = new Map<string, string[]>();
    for (const e of outgoing) {
      const targets = byVerb.get(e.v) ?? [];
      targets.push(iri(e.o));
      byVerb.set(e.v, targets);
    }
    for (const v of [...byVerb.keys()].sort()) {
      const targets = byVerb.get(v) ?? [];
      targets.sort((a, b) => (nameOf.get(a.slice(8)) ?? "").localeCompare(nameOf.get(b.slice(8)) ?? ""));
      entry[v] = targets;
    }
    return entry;
  });

  return `${JSON.stringify({ "@context": context, "@graph": graph }, null, 2)}\n`;
}

// ---- GraphML — superclass·confidence·fallback·by 를 속성으로 (AC4) ----

const xml = (s: string): string =>
  s
    // XML 1.0 이 허용하지 않는 제어문자(탭·개행·CR 제외)는 지운다 — 노트 제목에 하나만
    // 섞여도 내보낸 문서 전체가 파서에서 깨진다 (ISSUE-372). 이스케이프가 아니라 제거다:
    // 숫자 참조(&#x0;)로도 XML 1.0 에서는 불법이라 살릴 길이 없다.
    .replaceAll(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/gu, "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

export function exportGraphMl(store: GraphStore, registry: Registry): string {
  const { nodes, edges } = snapshot(store);
  const superclass = superclassOf(registry, new Set(edges.map((e) => e.v)));

  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<graphml xmlns="http://graphml.graphdrawing.org/xmlns"',
    '         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"',
    '         xsi:schemaLocation="http://graphml.graphdrawing.org/xmlns http://graphml.graphdrawing.org/xmlns/1.0/graphml.xsd">',
    '  <key id="name" for="node" attr.name="name" attr.type="string"/>',
    '  <key id="kind" for="node" attr.name="kind" attr.type="string"/>',
    '  <key id="aliases" for="node" attr.name="aliases" attr.type="string"/>',
    '  <key id="verb" for="edge" attr.name="verb" attr.type="string"/>',
    '  <key id="superclass" for="edge" attr.name="superclass" attr.type="string"/>',
    '  <key id="confidence" for="edge" attr.name="confidence" attr.type="double"/>',
    '  <key id="fallback" for="edge" attr.name="fallback" attr.type="boolean"/>',
    '  <key id="by" for="edge" attr.name="by" attr.type="string"/>',
    '  <graph id="ontoflow" edgedefault="directed">',
  ];
  for (const n of nodes) {
    lines.push(`    <node id="${xml(n.id)}">`);
    lines.push(`      <data key="name">${xml(n.name)}</data>`);
    lines.push(`      <data key="kind">${xml(n.kind)}</data>`);
    if (n.aliases.length > 0) {
      // 손실 없는 꼴로 — 쉼표 연결은 쉼표 든 별칭과 섞인다.
      lines.push(`      <data key="aliases">${xml(JSON.stringify(n.aliases))}</data>`);
    }
    lines.push("    </node>");
  }
  for (const e of edges) {
    lines.push(`    <edge id="${xml(e.id)}" source="${xml(e.s)}" target="${xml(e.o)}">`);
    lines.push(`      <data key="verb">${xml(e.v)}</data>`);
    lines.push(`      <data key="superclass">${xml(superclass.get(e.v) ?? "")}</data>`);
    lines.push(`      <data key="confidence">${e.confidence}</data>`);
    lines.push(`      <data key="fallback">${e.fallback}</data>`);
    lines.push(`      <data key="by">${xml(e.by)}</data>`);
    lines.push("    </edge>");
  }
  lines.push("  </graph>", "</graphml>", "");
  return lines.join("\n");
}
