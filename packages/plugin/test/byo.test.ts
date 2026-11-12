import { describe, expect, it } from "vitest";
import { SEED_REGISTRY, type Engine, type EngineFetchLike } from "../src/core.js";
import type { Extractor } from "../src/hub-client.js";
import { byoExtractor, extractorFor } from "../src/sync.js";
import { byoEndpointOf, parseSettings } from "../src/settings.js";

// BYO 추출 (#88) — 추출만 사용자 엔드포인트로: 허브 무접촉(AC1)·위반 출력 보류(AC2)·
// 미설정 무변(AC3)·자격증명 비전송(AC4)의 플러그인 쪽 검증.

const hubMustNotBeTouched: Extractor = {
  extractIncremental: () => {
    throw new Error("허브 호출 0 이어야 한다 (AC1)");
  },
  extractReindex: () => {
    throw new Error("허브 호출 0 이어야 한다 (AC1)");
  },
};

const EMPTY_OUTPUT = JSON.stringify({ edges: [], retracts: [], proposals: [] });

function fakeFetch(content: string): { calls: { url: string; headers: Record<string, string> }[]; fetchFn: EngineFetchLike } {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fetchFn: EngineFetchLike = async (url, init) => {
    calls.push({ url, headers: init.headers });
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ choices: [{ message: { content } }] }),
    };
  };
  return { calls, fetchFn };
}

const INCREMENTAL = {
  registry: SEED_REGISTRY,
  changes: [{ note: "스토아.md", diff: "@@\n+에픽테토스 서술" }],
  context: [],
};

describe("설정 — BYO 자격은 설정 저장소에만 산다 (#88)", () => {
  it("파싱 — 주소·모델은 다듬고, 빈 키는 null 이다", () => {
    const s = parseSettings({ byoUrl: " http://localhost:11434 ", byoModel: " m1 ", byoApiKey: "" });
    expect(s.byoUrl).toBe("http://localhost:11434");
    expect(s.byoModel).toBe("m1");
    expect(s.byoApiKey).toBeNull();
  });

  it("반쪽 설정은 BYO 가 아니다 — 주소만·모델만으로는 null (닫힌 기본)", () => {
    expect(byoEndpointOf(parseSettings({ byoUrl: "http://x" }))).toBeNull();
    expect(byoEndpointOf(parseSettings({ byoModel: "m1" }))).toBeNull();
    expect(byoEndpointOf(parseSettings({}))).toBeNull();
    expect(byoEndpointOf(parseSettings({ byoUrl: "http://x", byoModel: "m1" }))).toEqual({
      url: "http://x",
      model: "m1",
      apiKey: null,
    });
  });
});

describe("extractorFor — 경로 선택 (#88)", () => {
  it("AC3 — BYO 미설정이면 허브 추출기 그대로다 (기존 경로 무변)", () => {
    const { fetchFn } = fakeFetch(EMPTY_OUTPUT);
    expect(extractorFor(null, hubMustNotBeTouched, fetchFn)).toBe(hubMustNotBeTouched);
  });

  it("AC1·AC4 — BYO 가 서면 호출은 사용자 엔드포인트로만 가고, 키는 그 헤더로만 흐른다", async () => {
    const { calls, fetchFn } = fakeFetch(EMPTY_OUTPUT);
    const extractor = extractorFor(
      { url: "http://localhost:11434", model: "gemma3:27b", apiKey: "sk-로컬" },
      hubMustNotBeTouched,
      fetchFn,
    );
    const res = await extractor.extractIncremental(INCREMENTAL);
    expect(res.add).toEqual([]);
    expect(res.held).toEqual([]);
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) {
      expect(c.url.startsWith("http://localhost:11434/")).toBe(true); // 허브 무접촉 — AC5 의 구조면
      expect(c.headers.authorization).toBe("Bearer sk-로컬");
    }
  });

  it("재색인도 같은 자리를 지난다 — BYO 로컬에서 API2 꼴 그대로", async () => {
    const { calls, fetchFn } = fakeFetch(EMPTY_OUTPUT);
    const extractor = extractorFor(
      { url: "http://localhost:11434", model: "m1", apiKey: null },
      hubMustNotBeTouched,
      fetchFn,
    );
    const res = await extractor.extractReindex({
      registry: SEED_REGISTRY,
      notes: [{ note: "스토아.md", body: "에픽테토스는 스토아다" }],
    });
    expect(res.versions.registry).toBe(SEED_REGISTRY.version); // 재색인 버전 바인딩 그대로
    expect(res.edges).toEqual([]);
    expect(calls.every((c) => c.url.startsWith("http://localhost:11434/"))).toBe(true);
  });
});

describe("byoExtractor — 위반 출력의 기각 (#88 AC2)", () => {
  it("스키마 불합치 출력은 해당 노트 보류로 선다 — 정본 재료 0", async () => {
    const broken: Engine = { complete: async () => "스키마가 아니다 {" };
    const res = await byoExtractor(broken).extractIncremental(INCREMENTAL);
    expect(res.add).toEqual([]);
    expect(res.retract).toEqual([]);
    expect(res.held.map((h) => h.note)).toEqual(["스토아.md"]);
  });
});
