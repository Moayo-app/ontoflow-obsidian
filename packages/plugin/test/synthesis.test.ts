// 합성 배선 (ISSUE-59) — 동의 게이트(AC5)·합성 자리 수집 제외(AC3 의 자리 축)·트리거 왕복.
import { describe, expect, it } from "vitest";
import {
  OnboardingError,
  applyPatch,
  chooseVault,
  connectHub,
  grantConsent,
  loadSynthesisState,
  openVault,
  type EdgeWrite,
  type SynthesisNote,
} from "../src/core.js";
import type { HubClient } from "../src/hub-client.js";
import { PLUGIN_VAULT_DIR, obsidianFileIo } from "../src/obsidian-io.js";
import { loadRegistryFile } from "../src/registry-io.js";
import { updateOnboarding } from "../src/screens.js";
import { collectEvent, runSynthesis } from "../src/sync.js";
import { fakeVault } from "./fakes.js";

const NOW = "2026-11-01T12:00:00Z";

const NOTE: SynthesisNote = { title: "정리", md: "# 정리\n\n요약.\n" };

function synthesisHub(calls: { count: number }): HubClient {
  return {
    extractIncremental: async () => {
      throw new Error("이 테스트는 추출을 부르지 않는다");
    },
    extractReindex: async () => {
      throw new Error("이 테스트는 재색인을 부르지 않는다");
    },
    synthesize: async (input) => {
      calls.count += 1;
      expect(input.sourceId).toBe("logseq-main");
      expect(input.edges.length).toBeGreaterThan(0);
      return NOTE;
    },
    synthesizeTo: async () => {
      throw new Error("이 테스트는 API 출고를 부르지 않는다");
    },
    canonicalLoad: async (): Promise<never> => {
      throw new Error("이 테스트는 PG 정본을 부르지 않는다");
    },
    canonicalFlush: async (): Promise<never> => {
      throw new Error("이 테스트는 PG 정본을 부르지 않는다");
    },
    canonicalDrainInbox: async (): Promise<never> => {
      throw new Error("이 테스트는 PG 수집함을 부르지 않는다");
    },
    workspaceLoad: async (): Promise<never> => {
      throw new Error("이 테스트는 워크스페이스 투영을 부르지 않는다");
    },
    workspaceFlush: async (): Promise<never> => {
      throw new Error("이 테스트는 워크스페이스 투영을 부르지 않는다");
    },
    ingestSources: async (): Promise<never> => {
      throw new Error("이 테스트는 API 소스 수집을 부르지 않는다");
    },
    ingestPull: async (): Promise<never> => {
      throw new Error("이 테스트는 API 소스 수집을 부르지 않는다");
    },
    listWorkspaces: async (): Promise<never> => {
      throw new Error("이 테스트는 워크스페이스 목록을 부르지 않는다");
    },
    ping: async (): Promise<never> => {
      throw new Error("이 테스트는 연결 확인을 부르지 않는다");
    },
    projectTo: async (): Promise<never> => {
      throw new Error("이 테스트는 동기화 집행을 부르지 않는다");
    },
  };
}

const edge = (note: string): EdgeWrite => ({
  s: "카페인 섭취",
  v: "causes",
  o: "입면 지연",
  confidence: 0.9,
  fallback: false,
  by: "auto",
  src: { note, origin: "extract" },
});

async function setup() {
  const vault = fakeVault();
  const io = obsidianFileIo(vault.adapter);
  const store = await openVault(io, PLUGIN_VAULT_DIR);
  const registry = await loadRegistryFile(io, PLUGIN_VAULT_DIR);
  await applyPatch(store, registry, { add: [edge("logseq-main:/n1/아침.md")], retract: [] });
  return { vault, io, store };
}

describe("합성 트리거 (AC1·AC5)", () => {
  it("`§23` 동의 전에는 시작 0 — 허브 호출·쓰기 전부 없다 (AC5, negative)", async () => {
    const { io, store } = await setup();
    const calls = { count: 0 };
    await expect(runSynthesis(io, PLUGIN_VAULT_DIR, store, synthesisHub(calls), "logseq-main", NOW)).rejects.toThrow(
      OnboardingError,
    );
    expect(calls.count).toBe(0);
  });

  it("동의 뒤 — 부분 그래프가 허브 판정을 받아 기계 자리에 서고 상태가 박힌다 (AC1)", async () => {
    const { vault, io, store } = await setup();
    await updateOnboarding(io, PLUGIN_VAULT_DIR, (s) => grantConsent(chooseVault(connectHub(s)), NOW));
    const calls = { count: 0 };
    const { path } = await runSynthesis(io, PLUGIN_VAULT_DIR, store, synthesisHub(calls), "logseq-main", NOW);
    expect(calls.count).toBe(1);
    expect(path).toBe("ontoflow-notes/logseq-main.md");
    const written = await vault.adapter.read("ontoflow-notes/logseq-main.md");
    expect(written).toContain("written-by: ontoflow");
    expect(written).toContain("# 정리");
    expect((await loadSynthesisState(io, PLUGIN_VAULT_DIR)).notes["logseq-main"]?.path).toBe(path);
  });
});

describe("합성 자리 수집 제외 (AC3 의 자리 축, negative)", () => {
  it("합성 자리 파일의 vault 이벤트는 수집 산출 0 — 마커 없이도 자리가 막는다", async () => {
    const { io } = await setup();
    const change = await collectEvent(io, PLUGIN_VAULT_DIR, {
      kind: "write",
      path: "ontoflow-notes/아무거나.md",
      content: "마커 없는 내용이라도 자리가 막는다\n",
      stat: { mtime: 1, size: 10 },
    });
    expect(change).toBeNull();

    // 일반 자리는 그대로 수집된다 — 제외가 과하지 않다.
    const normal = await collectEvent(io, PLUGIN_VAULT_DIR, {
      kind: "write",
      path: "notes/일반.md",
      content: "본문\n",
      stat: { mtime: 1, size: 3 },
    });
    expect(normal).toMatchObject({ kind: "created" });
  });
});
