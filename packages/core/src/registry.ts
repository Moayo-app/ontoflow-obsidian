// 동사 등록부 (F6) — 닫힌 집합 · 커스텀 동사 제안 수명주기.
// 데이터 계약의 정본은 스펙(#1 「데이터 계약 — 동사 등록부」), 결의는 moayo-hq#271.
import { parse, stringify } from "yaml";

// 상위분류 다섯 — moayo-hq#271 결의 1. 속성은 관계가 아니라 노드 키-값.
export const SUPERCLASSES = ["분류", "구성", "인과", "순차", "연관"] as const;
export type Superclass = (typeof SUPERCLASSES)[number];

// 등록부 밖 관계가 내려앉는 폴백 자리 — 제거 불가.
export const FALLBACK_VERB_ID = "related-to";

/**
 * 동사 id 꼴 (ISSUE-360) — kebab 식별자. 지표 신호의 ID_SHAPE(retention — `[A-Za-z0-9_.:-]`)의
 * 부분집합이라, 등록부를 통과한 id 는 과금 커밋 뒤의 지표 기록에서 결코 던지지 않는다
 * (그 던짐이 「크레딧은 빠지고 엣지는 유실, 같은 노트 영구 반복」이었다). 원문·한글은 label 의
 * 자리다 — 동사 원문 보존(moayo-hq#271)은 id 가 아니라 label·verbRaw 가 진다.
 */
export const VERB_ID_SHAPE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** 라벨·원문 → id 제안 (ISSUE-360) — ASCII 로 눕힌 kebab. 한글 원문처럼 남는 게 없으면 빈 문자열. */
export function suggestVerbId(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");
}

// 같은 미등록 관계 후보가 이 횟수 이상 관측되면 제안으로 승격된다 (스펙 AC21).
export const PROPOSAL_THRESHOLD = 2;

export interface Verb {
  id: string;
  superclass: Superclass;
  label: string;
}

export interface Registry {
  version: number;
  superclasses: readonly Superclass[];
  verbs: Verb[];
}

export class RegistryError extends Error {
  constructor(readonly problems: string[]) {
    super(`등록부 검증 실패:\n- ${problems.join("\n- ")}`);
    this.name = "RegistryError";
  }
}

// 씨앗 — moayo-hq#270 측정 등록부 8동사 승계.
export const SEED_REGISTRY: Registry = {
  version: 1,
  superclasses: SUPERCLASSES,
  verbs: [
    { id: "is-a", superclass: "분류", label: "종류다" },
    { id: "instance-of", superclass: "분류", label: "사례다" },
    { id: "part-of", superclass: "구성", label: "부분이다" },
    { id: "causes", superclass: "인과", label: "유발한다" },
    { id: "supports", superclass: "인과", label: "뒷받침한다" },
    { id: "refutes", superclass: "인과", label: "반박한다" },
    { id: "precedes", superclass: "순차", label: "선행한다" },
    { id: "related-to", superclass: "연관", label: "연관된다" },
  ],
};

function isSuperclass(value: unknown): value is Superclass {
  return typeof value === "string" && (SUPERCLASSES as readonly string[]).includes(value);
}

function validate(doc: unknown): Registry {
  const problems: string[] = [];
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
    throw new RegistryError(["등록부 최상위가 매핑이 아니다"]);
  }
  const raw = doc as Record<string, unknown>;

  if (!Number.isInteger(raw.version) || (raw.version as number) < 1) {
    problems.push(`version 은 1 이상의 정수여야 한다 (현재: ${JSON.stringify(raw.version)})`);
  }

  const sc = raw.superclasses;
  if (
    !Array.isArray(sc) ||
    sc.length !== SUPERCLASSES.length ||
    SUPERCLASSES.some((s, i) => sc[i] !== s)
  ) {
    problems.push(`superclasses 는 정확히 [${SUPERCLASSES.join(", ")}] 이어야 한다`);
  }

  const verbs: Verb[] = [];
  if (!Array.isArray(raw.verbs)) {
    problems.push("verbs 는 목록이어야 한다");
  } else {
    const seen = new Set<string>();
    raw.verbs.forEach((v: unknown, i: number) => {
      if (typeof v !== "object" || v === null) {
        problems.push(`verbs[${i}] 가 매핑이 아니다`);
        return;
      }
      const { id, superclass, label } = v as Record<string, unknown>;
      if (typeof id !== "string" || id.length === 0) {
        problems.push(`verbs[${i}].id 가 비어 있다`);
        return;
      }
      if (!VERB_ID_SHAPE.test(id)) {
        // 꼴 강제 (ISSUE-360) — 사용자 0명 시점 추가라 마이그레이션 0: 꼴 밖 id 는 명시 거부다.
        problems.push(`verbs[${i}].id 는 kebab 식별자 꼴이어야 한다 (${VERB_ID_SHAPE}): "${id}" — 원문·한글은 label 의 자리다`);
      }
      if (seen.has(id)) problems.push(`중복 id: ${id}`);
      seen.add(id);
      if (!isSuperclass(superclass)) {
        problems.push(`verbs[${i}](${id}).superclass 가 미지다: ${JSON.stringify(superclass)}`);
      }
      if (typeof label !== "string" || label.length === 0) {
        problems.push(`verbs[${i}](${id}).label 이 비어 있다`);
      }
      if (isSuperclass(superclass) && typeof label === "string" && label.length > 0) {
        verbs.push({ id, superclass, label });
      }
    });
    const fallback = verbs.find((v) => v.id === FALLBACK_VERB_ID);
    if (!fallback) {
      problems.push(`폴백 동사 ${FALLBACK_VERB_ID} 가 없다 — 등록부 밖 관계가 내려앉을 자리가 사라진다`);
    } else if (fallback.superclass !== "연관") {
      problems.push(`폴백 동사 ${FALLBACK_VERB_ID} 의 상위분류는 연관이어야 한다`);
    }
  }

  if (problems.length > 0) throw new RegistryError(problems);
  return { version: raw.version as number, superclasses: SUPERCLASSES, verbs };
}

// 손상 등록부는 거부·보고한다 — 임의 보정 0 (스펙 AC23).
export function parseRegistry(yamlText: string): Registry {
  let doc: unknown;
  try {
    doc = parse(yamlText);
  } catch (e) {
    throw new RegistryError([`YAML 오류: ${(e as Error).message}`]);
  }
  return validate(doc);
}

export function serializeRegistry(registry: Registry): string {
  return stringify({
    version: registry.version,
    superclasses: [...registry.superclasses],
    verbs: registry.verbs.map((v) => ({ ...v })),
  });
}

// 허브 추출 호출의 json_schema 동사 enum 제약 (스펙 AC1·AC2 의 구조 보장 자리).
export function verbEnum(registry: Registry): string[] {
  return registry.verbs.map((v) => v.id);
}

// ---- 커스텀 동사 제안 수명주기 — 생성은 기계, 확정은 사람 (moayo-hq#271 결의 4) ----

export type ProposalStatus = "observed" | "proposed" | "confirmed" | "rejected";

export interface Observation {
  verbRaw: string; // 관계 서술의 동사 원문
  superclassHint?: Superclass; // 추출이 실어 온 상위분류 추천
  note: string; // 관측 출처 노트 (vault 상대 경로)
}

export interface Proposal {
  verbRaw: string;
  status: ProposalStatus;
  observations: Observation[];
  recommendedSuperclass: Superclass;
}

function recommend(observations: Observation[]): Superclass {
  const counts = new Map<Superclass, number>();
  for (const o of observations) {
    if (o.superclassHint) counts.set(o.superclassHint, (counts.get(o.superclassHint) ?? 0) + 1);
  }
  let best: Superclass = "연관";
  let bestCount = 0;
  for (const s of SUPERCLASSES) {
    const c = counts.get(s) ?? 0;
    if (c > bestCount) {
      best = s;
      bestCount = c;
    }
  }
  return best;
}

// 미등록 관계의 관측 하나를 접수한다. 같은 원문이 PROPOSAL_THRESHOLD 회 이상 쌓이면
// 제안으로 승격된다 — 등록부는 건드리지 않는다 (스펙 AC21·AC22).
export function observe(proposals: readonly Proposal[], observation: Observation): Proposal[] {
  const verbRaw = observation.verbRaw.trim();
  if (verbRaw.length === 0) throw new RegistryError(["관측의 동사 원문이 비어 있다"]);
  const next = proposals.map((p) => ({ ...p, observations: [...p.observations] }));
  const existing = next.find((p) => p.verbRaw === verbRaw);
  if (!existing) {
    next.push({
      verbRaw,
      status: PROPOSAL_THRESHOLD <= 1 ? "proposed" : "observed",
      observations: [observation],
      recommendedSuperclass: recommend([observation]),
    });
    return next;
  }
  existing.observations.push(observation);
  // 확정·기각된 제안은 되살아나지 않는다 — 기각 기록은 재노출 0 의 근거다.
  if (existing.status === "observed" && existing.observations.length >= PROPOSAL_THRESHOLD) {
    existing.status = "proposed";
  }
  if (existing.status === "observed" || existing.status === "proposed") {
    existing.recommendedSuperclass = recommend(existing.observations);
  }
  return next;
}

// 사람의 확정 — 이때만 등록부가 바뀌고 버전이 오른다 (스펙 AC21 확정 쪽 · 이슈 AC5).
export function confirmProposal(
  registry: Registry,
  proposals: readonly Proposal[],
  verbRaw: string,
  verb: Verb,
): { registry: Registry; proposals: Proposal[] } {
  const target = proposals.find((p) => p.verbRaw === verbRaw.trim());
  if (!target) throw new RegistryError([`제안이 없다: ${verbRaw}`]);
  if (target.status !== "proposed") {
    throw new RegistryError([`확정 대상은 proposed 제안뿐이다 (현재: ${target.status})`]);
  }
  if (registry.verbs.some((v) => v.id === verb.id)) {
    throw new RegistryError([`이미 등록된 id 다: ${verb.id}`]);
  }
  if (!isSuperclass(verb.superclass)) {
    throw new RegistryError([`미지 상위분류다: ${JSON.stringify(verb.superclass)}`]);
  }
  if (!VERB_ID_SHAPE.test(verb.id)) {
    // AI 제안 확정 경로 포함 (ISSUE-360) — suggestVerbId(라벨→kebab)가 기본값을 깔아 준다.
    throw new RegistryError([`동사 id 는 kebab 식별자 꼴이어야 한다 (${VERB_ID_SHAPE}): "${verb.id}" — 원문·한글은 label 의 자리다`]);
  }
  if (verb.label.length === 0) {
    throw new RegistryError(["동사 label 은 비어 있을 수 없다"]);
  }
  return {
    registry: {
      ...registry,
      version: registry.version + 1, // 버전 업이 재색인 경로의 트리거다
      verbs: [...registry.verbs, { ...verb }],
    },
    proposals: proposals.map((p) =>
      p.verbRaw === target.verbRaw ? { ...p, status: "confirmed" as const } : p,
    ),
  };
}

export function rejectProposal(proposals: readonly Proposal[], verbRaw: string): Proposal[] {
  const target = proposals.find((p) => p.verbRaw === verbRaw.trim());
  if (!target) throw new RegistryError([`제안이 없다: ${verbRaw}`]);
  return proposals.map((p) =>
    p.verbRaw === target.verbRaw ? { ...p, status: "rejected" as const } : p,
  );
}

// 동사 제거 — 참조 엣지가 있으면 거부한다: 고아 동사 엣지 0 (이슈 AC6).
// 재분류는 등록부 버전 업 + 재색인 경로가 담당한다 (moayo-hq#271 결의 2).
export function removeVerb(
  registry: Registry,
  verbId: string,
  referencingEdges: number,
): Registry {
  if (verbId === FALLBACK_VERB_ID) {
    throw new RegistryError([`폴백 동사 ${FALLBACK_VERB_ID} 는 제거할 수 없다`]);
  }
  if (!registry.verbs.some((v) => v.id === verbId)) {
    throw new RegistryError([`등록부에 없는 동사다: ${verbId}`]);
  }
  if (referencingEdges > 0) {
    throw new RegistryError([
      `동사 ${verbId} 를 참조하는 엣지가 ${referencingEdges}건 있다 — 제거 대신 재분류(등록부 버전 업 + 재색인) 경로를 쓴다`,
    ]);
  }
  return {
    ...registry,
    version: registry.version + 1,
    verbs: registry.verbs.filter((v) => v.id !== verbId),
  };
}
