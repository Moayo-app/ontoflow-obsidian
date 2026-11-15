import { describe, expect, it } from "vitest";
import {
  chooseVault,
  connectHub,
  grantConsent,
  loadDictionary,
  loadOnboarding,
  loadReviewQueue,
  openVault,
  progressLabel,
  projectionDataFor,
  type FileIo,
} from "../src/core.js";
import { projectNoteCommand } from "../src/commands.js";
import type { HubClient } from "../src/hub-client.js";
import { PLUGIN_VAULT_DIR, obsidianFileIo } from "../src/obsidian-io.js";
import { loadRegistryFile } from "../src/registry-io.js";
import { onboardingView, reviewView, updateOnboarding } from "../src/screens.js";
import {
  EVENT_MAX_WAIT_MS,
  EVENT_QUIET_MS,
  applyLocal,
  catchUp,
  collectEvent,
  collectEvents,
  holdForLater,
  nextFlushDelay,
  observedFromEvents,
  promoteProjectionEdits,
  runInitialIndex,
  sendToHub,
  takeHeld,
  type VaultEvent,
} from "../src/sync.js";
import { fakeReader, fakeVault } from "./fakes.js";

async function openTestVault() {
  const vault = fakeVault();
  const io = obsidianFileIo(vault.adapter);
  const store = await openVault(io, PLUGIN_VAULT_DIR);
  const registry = await loadRegistryFile(io, PLUGIN_VAULT_DIR);
  return { vault, io, store, registry };
}

async function grantAll(io: FileIo): Promise<void> {
  await updateOnboarding(io, PLUGIN_VAULT_DIR, (s) =>
    grantConsent(chooseVault(connectHub(s)), "2026-11-01T00:00:00Z"),
  );
}

// 합성(#59)과 무관한 테스트들의 채움 — 부르면 테스트 버그다.
const noSynthesis = {
  synthesize: async (): Promise<never> => {
    throw new Error("이 테스트는 합성을 부르지 않는다");
  },
  synthesizeTo: async (): Promise<never> => {
    throw new Error("이 테스트는 합성을 부르지 않는다");
  },
  canonicalLoad: async (): Promise<never> => {
    throw new Error("이 테스트는 PG 정본을 부르지 않는다");
  },
  canonicalFlush: async (): Promise<never> => {
    throw new Error("이 테스트는 PG 정본을 부르지 않는다");
  },
  canonicalPeekInbox: async (): Promise<never> => {
    throw new Error("이 테스트는 PG 수집함을 부르지 않는다");
  },
  canonicalAckInbox: async (): Promise<never> => {
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

const deadHub: HubClient = {
  ...noSynthesis,
  extractIncremental: async () => {
    throw new Error("허브가 닿지 않는다");
  },
  extractReindex: async () => {
    throw new Error("허브가 닿지 않는다");
  },
};

describe("수집 배선 — vault 왕복 (이슈 #42 AC1·AC2)", () => {
  it("수집 → 로컬 효과: 위키링크 폴백 엣지·타이핑 제안이 허브 없이 즉시 선다", async () => {
    const { io, store, registry } = await openTestVault();
    const content = "에픽테토스 공부 — [[스토아 철학]]을 다시 본다.";
    const change = await collectEvent(io, PLUGIN_VAULT_DIR, {
      kind: "write",
      path: "스토아.md",
      content,
      stat: { mtime: 1, size: content.length },
    });
    expect(change).not.toBeNull();
    const effects = await applyLocal(io, PLUGIN_VAULT_DIR, store, registry, [change!]);
    expect(effects.patch.added).toBe(1);
    expect(effects.typingsQueued).toBe(1);
    const data = projectionDataFor(store, "스토아.md");
    expect(data.edges).toHaveLength(1);
    expect(data.edges[0]).toMatchObject({ v: "related-to", fallback: true, to: "스토아 철학" });
    // AC6 의 앞면 — 제안은 자동 수락 없이 pending 으로만 선다
    expect((await reviewView(io, PLUGIN_VAULT_DIR)).typings).toHaveLength(1);
  });

  it("AC2 — `§23` 동의 전에는 허브 호출이 0 이다: 증분도 최초 색인도 선다", async () => {
    const { io, store, registry } = await openTestVault();
    let called = 0;
    const spyHub: HubClient = {
      ...noSynthesis,
      extractIncremental: async () => {
        called += 1;
        throw new Error("호출되면 안 된다");
      },
      extractReindex: async () => {
        called += 1;
        throw new Error("호출되면 안 된다");
      },
    };
    const content = "기준금리 인상이 대출 수요 감소를 불렀다.";
    const change = await collectEvent(io, PLUGIN_VAULT_DIR, {
      kind: "write",
      path: "경제.md",
      content,
      stat: { mtime: 1, size: content.length },
    });
    await expect(
      sendToHub(io, PLUGIN_VAULT_DIR, store, registry, spyHub, [change!]),
    ).rejects.toThrow(/동의/);
    // 허브 연결·vault 선택이 있어도 동의가 빠지면 최초 색인도 시작 0 이다
    await updateOnboarding(io, PLUGIN_VAULT_DIR, (s) => chooseVault(connectHub(s)));
    await expect(
      runInitialIndex(io, PLUGIN_VAULT_DIR, fakeReader(new Map()), registry, spyHub, "2026-11-01T00:00:00Z"),
    ).rejects.toThrow(/동의/);
    expect(called).toBe(0);
  });

  it("AC1 — 허브 왕복: 증분 응답이 정본에 앉고, 동사 관측이 검토 큐에 선다", async () => {
    const { io, store, registry } = await openTestVault();
    await grantAll(io);
    const content = "에픽테토스는 스토아 철학을 평생 뒷받침하는 삶을 살았다.";
    await io.writeText("스토아.md", content);
    const change = await collectEvent(io, PLUGIN_VAULT_DIR, {
      kind: "write",
      path: "스토아.md",
      content,
      stat: { mtime: 1, size: content.length },
    });
    let seen: { changes: { note: string }[] } | null = null;
    const hub: HubClient = {
      ...noSynthesis,
      extractIncremental: async (call) => {
        seen = call;
        return {
          add: [
            {
              s: "에픽테토스",
              v: "supports",
              o: "스토아 철학",
              confidence: 0.9,
              fallback: false,
              by: "auto",
              src: { note: "스토아.md", origin: "extract" },
            },
          ],
          retract: [],
          proposals: [{ verbRaw: "대표한다", superclassHint: "연관", note: "스토아.md" }],
          held: [{ note: "큰노트.md", reason: "예산 초과" }],
          aliases: [],
          merges: [],
        };
      },
      extractReindex: async () => {
        throw new Error("안 쓴다");
      },
    };
    const r = await sendToHub(io, PLUGIN_VAULT_DIR, store, registry, hub, [change!]);
    expect(r.patch.added).toBe(1);
    expect(r.held).toHaveLength(1);
    expect(seen!.changes.map((c) => c.note)).toEqual(["스토아.md"]);
    expect(projectionDataFor(store, "스토아.md").edges.map((e) => e.v)).toContain("supports");
    // 동사 관측 1회 — 임계(2) 전이라 제안 목록엔 아직 없고, 큐에는 접수됐다
    expect((await loadReviewQueue(io, PLUGIN_VAULT_DIR)).verbs).toHaveLength(1);
    expect((await reviewView(io, PLUGIN_VAULT_DIR)).verbs).toHaveLength(0);

    // AC1 의 닫힘 — 투영 블록은 재수집되지 않는다
    const projected = await projectNoteCommand(io, PLUGIN_VAULT_DIR, store, "스토아.md");
    expect(projected.changed).toBe(true);
    const after = await io.readText("스토아.md");
    expect(after).toContain("written-by: ontoflow");
    const again = await collectEvent(io, PLUGIN_VAULT_DIR, {
      kind: "write",
      path: "스토아.md",
      content: after!,
      stat: { mtime: 2, size: after!.length },
    });
    expect(again).toBeNull();
  });

  it("오프라인 — 허브 실패분이 보류 큐에 쌓이고, 재시도가 비워 반영한다 (#12 AC5)", async () => {
    const { io, store, registry } = await openTestVault();
    await grantAll(io);
    const content = "과훈련이 무릎 통증을 유발했다.";
    const change = await collectEvent(io, PLUGIN_VAULT_DIR, {
      kind: "write",
      path: "운동.md",
      content,
      stat: { mtime: 1, size: content.length },
    });
    await expect(sendToHub(io, PLUGIN_VAULT_DIR, store, registry, deadHub, [change!])).rejects.toThrow();
    await holdForLater(io, PLUGIN_VAULT_DIR, [change!]);
    const held = await takeHeld(io, PLUGIN_VAULT_DIR);
    expect(held.map((c) => c.note)).toEqual(["운동.md"]);
    expect(await takeHeld(io, PLUGIN_VAULT_DIR)).toHaveLength(0); // 비웠다
    const okHub: HubClient = {
      ...noSynthesis,
      extractIncremental: async () => ({
        add: [
          {
            s: "과훈련",
            v: "causes",
            o: "무릎 통증",
            confidence: 0.9,
            fallback: false,
            by: "auto",
            src: { note: "운동.md", origin: "extract" },
          },
        ],
        retract: [],
        proposals: [],
        held: [],
        aliases: [],
        merges: [],
      }),
      extractReindex: async () => {
        throw new Error("안 쓴다");
      },
    };
    const r = await sendToHub(io, PLUGIN_VAULT_DIR, store, registry, okHub, held);
    expect(r.patch.added).toBe(1);
  });

  it("#47 — 정규화 산출 반영: 별칭은 사전에 박히고, 임계 미만 제안은 S2 pending 으로만 선다", async () => {
    const { io, store, registry } = await openTestVault();
    await grantAll(io);
    const content = "엡틱테토스 정리.";
    const change = await collectEvent(io, PLUGIN_VAULT_DIR, {
      kind: "write",
      path: "스토아.md",
      content,
      stat: { mtime: 1, size: content.length },
    });
    let dictionarySent = false;
    const hub: HubClient = {
      ...noSynthesis,
      extractIncremental: async (call) => {
        dictionarySent = call.dictionary !== undefined; // 사전 동봉 — 허브 정규화의 입력
        return {
          add: [
            {
              s: "에픽테토스", // 허브가 이미 정본명으로 정규화해 보냈다
              v: "supports",
              o: "스토아 철학",
              confidence: 0.9,
              fallback: false,
              by: "auto",
              src: { note: "스토아.md", origin: "extract" },
            },
          ],
          retract: [],
          proposals: [],
          held: [],
          aliases: [{ node: "에픽테토스", alias: "엡틱테토스" }],
          merges: [{ kind: "merge", name: "스토아철학", node: "스토아 철학", confidence: 0.6 }],
        };
      },
      extractReindex: async () => {
        throw new Error("안 쓴다");
      },
    };
    const r = await sendToHub(io, PLUGIN_VAULT_DIR, store, registry, hub, [change!]);
    expect(dictionarySent).toBe(true);
    expect(r.aliasesRecorded).toBe(1);
    expect(r.mergesQueued).toBe(1);
    // 별칭이 사전에 박혀 다음 요청의 사전 히트가 된다
    expect(loadDictionary(store).nodes.find((n) => n.name === "에픽테토스")?.aliases).toContain(
      "엡틱테토스",
    );
    // 임계 미만 제안은 자동 수락 0 — S2 pending 으로만 선다 (#42 AC6 보존)
    expect((await reviewView(io, PLUGIN_VAULT_DIR)).merges).toHaveLength(1);
    expect(loadDictionary(store).nodes.find((n) => n.name === "스토아 철학")?.aliases ?? []).not.toContain(
      "스토아철학",
    );
  });

  it("삭제 — 철회는 로컬이다: 노트의 출처 엣지가 허브 없이 내려간다", async () => {
    const { io, store, registry } = await openTestVault();
    await grantAll(io);
    const content = "[[제텔카스텐]] 정리.";
    const change = await collectEvent(io, PLUGIN_VAULT_DIR, {
      kind: "write",
      path: "옵시디언.md",
      content,
      stat: { mtime: 1, size: content.length },
    });
    await applyLocal(io, PLUGIN_VAULT_DIR, store, registry, [change!]);
    expect(projectionDataFor(store, "옵시디언.md").edges).toHaveLength(1);
    const del = await collectEvent(io, PLUGIN_VAULT_DIR, { kind: "delete", path: "옵시디언.md" });
    const effects = await applyLocal(io, PLUGIN_VAULT_DIR, store, registry, [del!]);
    expect(effects.retractedNotes).toEqual(["옵시디언.md"]);
    expect(projectionDataFor(store, "옵시디언.md").edges).toHaveLength(0);
  });

  it("최초 색인 — 재색인 응답이 정본을 원자 교체하고 온보딩이 완료로 찍힌다", async () => {
    const { io, registry } = await openTestVault();
    await grantAll(io);
    const notes = new Map([
      ["스토아.md", { body: "에픽테토스는 스토아 철학을 대표한다.", mtime: 1 }],
      ["요리.md", { body: "돼지고기 볶기 다음에 김치 넣고 볶기.", mtime: 1 }],
    ]);
    const hub: HubClient = {
      ...noSynthesis,
      extractIncremental: async () => {
        throw new Error("안 쓴다");
      },
      extractReindex: async (call) => {
        expect(call.notes).toHaveLength(2);
        return {
          edges: [
            {
              s: "돼지고기 볶기",
              v: "precedes",
              o: "김치 넣고 볶기",
              confidence: 0.9,
              fallback: false,
              by: "auto",
              src: { note: "요리.md", origin: "extract" },
            },
          ],
          proposals: [],
          held: [],
          versions: { registry: registry.version, prompt: "p1" },
          aliases: [],
          merges: [],
        };
      },
    };
    const result = await runInitialIndex(
      io,
      PLUGIN_VAULT_DIR,
      fakeReader(notes),
      registry,
      hub,
      "2026-11-01T00:00:00Z",
    );
    expect(result.total).toBe(2);
    expect(projectionDataFor(result.store, "요리.md").edges).toHaveLength(1);
    const onboarding = await loadOnboarding(io, PLUGIN_VAULT_DIR);
    expect(onboarding.completedAt).toBe("2026-11-01T00:00:00Z");
    expect(progressLabel(onboarding)).toBe("2/2");
  });

  it("최초 색인 실패가 시작 전으로 원복되고, 재시도가 선다 (ISSUE-431 — 막다른 길 제거)", async () => {
    const { io, registry } = await openTestVault();
    await grantAll(io);
    const notes = new Map([["스토아.md", { body: "에픽테토스는 스토아 철학을 대표한다.", mtime: 1 }]]);
    let calls = 0;
    const hub: HubClient = {
      ...noSynthesis,
      extractIncremental: async () => {
        throw new Error("안 쓴다");
      },
      extractReindex: async () => {
        calls += 1;
        if (calls === 1) throw new Error("일시 오류"); // 허브 타임아웃 한 번 — 옛 코드는 여기서 영구 비활성이었다
        return {
          edges: [],
          proposals: [],
          held: [],
          versions: { registry: registry.version, prompt: "p1" },
          aliases: [],
          merges: [],
        };
      },
    };
    await expect(
      runInitialIndex(io, PLUGIN_VAULT_DIR, fakeReader(notes), registry, hub, "2026-11-01T00:00:00Z"),
    ).rejects.toThrow("일시 오류");
    const after = await loadOnboarding(io, PLUGIN_VAULT_DIR);
    expect(after.indexing).toBeNull(); // 원복 — 「색인 시작」 버튼이 다시 선다
    expect(onboardingView(after).canStartIndex).toBe(true);
    expect(after.completedAt).toBeNull();

    const result = await runInitialIndex(
      io,
      PLUGIN_VAULT_DIR,
      fakeReader(notes),
      registry,
      hub,
      "2026-11-02T00:00:00Z",
    );
    expect(result.total).toBe(1);
    expect((await loadOnboarding(io, PLUGIN_VAULT_DIR)).completedAt).toBe("2026-11-02T00:00:00Z");
  });
});

// ---- PG 정본 (#63) — 적재·반영의 플러그인 배선: 정본은 PG, 로컬은 세션 작업 사본 ----

describe("PG 정본 적재·반영 (#63 AC4·AC5)", () => {
  async function seededDump() {
    const { io, store, registry } = await openTestVault();
    const { applyPatch } = await import("../src/core.js");
    await applyPatch(store, registry, {
      add: [
        {
          s: "카페인",
          v: "causes",
          o: "불면",
          confidence: 0.9,
          fallback: false,
          by: "user" as const,
          src: { note: "n.md", origin: "extract" as const },
        },
      ],
      retract: [],
    });
    const { dumpCanonical } = await import("../src/core.js");
    return { dump: dumpCanonical(store, registry, 3), io };
  }

  it("적재 — 허브 덤프가 작업본으로 서고, 등록부 작업 사본이 vault 에 깔린다 (AC4)", async () => {
    const { dump } = await seededDump();
    const vault = fakeVault();
    const io = obsidianFileIo(vault.adapter);
    const hub = { ...noSynthesis, canonicalLoad: async () => dump } as unknown as HubClient;

    const { loadPgCanonical } = await import("../src/sync.js");
    const handle = await loadPgCanonical(io, PLUGIN_VAULT_DIR, hub);
    expect(handle.rev).toBe(3);
    expect(projectionDataFor(handle.store, "n.md").edges.length).toBeGreaterThan(0);
    // 등록부 작업 사본 — 이후 판정 코드가 vault 파일을 그대로 읽는다 (경로 분기 0).
    const registry = await loadRegistryFile(io, PLUGIN_VAULT_DIR);
    expect(registry.verbs.map((v) => v.id)).toEqual(handle.registry.verbs.map((v) => v.id));
  });

  it("반영 — 작업본 덤프가 현재 rev 로 밀리고 다음 rev 를 받는다; 409 는 그대로 솟는다 (AC5)", async () => {
    const { dump } = await seededDump();
    const vault = fakeVault();
    const io = obsidianFileIo(vault.adapter);
    const flushed: { rev: number }[] = [];
    const hub = {
      ...noSynthesis,
      canonicalLoad: async () => dump,
      canonicalFlush: async (d: { rev: number }) => {
        flushed.push({ rev: d.rev });
        return { rev: d.rev + 1 };
      },
    } as unknown as HubClient;

    const { loadPgCanonical, flushPgCanonical } = await import("../src/sync.js");
    const handle = await loadPgCanonical(io, PLUGIN_VAULT_DIR, hub);
    const next = await flushPgCanonical(io, PLUGIN_VAULT_DIR, hub, handle.store, handle.rev);
    expect(flushed).toEqual([{ rev: 3 }]); // 가드는 적재 시점 rev 다
    expect(next).toBe(4);

    const conflicted = {
      ...hub,
      canonicalFlush: async (): Promise<never> => {
        throw new Error("HTTP 409:\n- rev 가드 불일치 — 다른 반영이 먼저 섰다: 다시 적재한다 (AC5)");
      },
    } as unknown as HubClient;
    await expect(flushPgCanonical(io, PLUGIN_VAULT_DIR, conflicted, handle.store, next)).rejects.toThrow("409");
  });

  it("설정 — canonical 은 sqlite 기본·pg 명시만 선다 (알 수 없는 값은 기본으로 접힌다)", async () => {
    const { parseSettings } = await import("../src/settings.js");
    expect(parseSettings(undefined).canonical).toBe("sqlite");
    expect(parseSettings({ canonical: "pg" }).canonical).toBe("pg");
    expect(parseSettings({ canonical: "mysql" }).canonical).toBe("sqlite");
  });
});

// ---- 재부상 (#80) — 수집 사이클 편승 한 판: 판정 → 큐 → 리포트(기계 자리) ----

describe("재부상 한 판 (#80 AC3·AC4)", () => {
  async function contradictedVault() {
    const { io, store, registry } = await openTestVault();
    const { applyPatch } = await import("../src/core.js");
    const e = (s: string, o: string) => ({
      s,
      v: "causes",
      o,
      confidence: 0.9,
      fallback: false,
      by: "auto" as const,
      src: { note: "n.md", origin: "extract" as const },
    });
    await applyPatch(store, registry, { add: [e("카페인", "불면"), e("불면", "카페인")], retract: [] });
    return { io, store, registry };
  }

  it("주기 도래 → 판정이 큐에 서고 리포트가 기계 자리에 선다 — 마커 포함 (AC3)", async () => {
    const { io, store, registry } = await contradictedVault();
    const { runResurface } = await import("../src/sync.js");
    const { loadReviewQueue, pendingItems } = await import("../src/core.js");

    const outcome = await runResurface(io, PLUGIN_VAULT_DIR, store, registry, "2026-11-01T00:00:00Z", false);
    expect(outcome).not.toBeNull();
    expect(outcome?.queued).toBe(1);
    expect(outcome?.reportPath).toBe("ontoflow-notes/주간-리포트.md");
    const body = await io.readText(`${PLUGIN_VAULT_DIR}/${outcome?.reportPath}`);
    expect(body).toContain("written-by: ontoflow"); // 메아리 차단 마커 (#59 의미론)
    expect(body).toContain("모순");
    expect(pendingItems(await loadReviewQueue(io, PLUGIN_VAULT_DIR)).inferences).toHaveLength(1);

    // 같은 날 재실행 — 주기 미도래라 돌지 않는다 (편승 트리거의 분모).
    expect(await runResurface(io, PLUGIN_VAULT_DIR, store, registry, "2026-11-02T00:00:00Z", false)).toBeNull();
    // 7일 뒤 — 미해소 pending 모순은 리마인드로 다시 실리되 큐 재적재는 0 (재노출 0).
    const next = await runResurface(io, PLUGIN_VAULT_DIR, store, registry, "2026-11-08T00:00:01Z", false);
    expect(next).toMatchObject({ reportPath: "ontoflow-notes/주간-리포트.md", queued: 0 });
    // 사용자가 「둘 다 유지」 하면 — 그 발견은 리포트에서도 사라진다 (판정 존중 · AC4).
    const { dismissInferenceAction } = await import("../src/screens.js");
    const inf = pendingItems(await loadReviewQueue(io, PLUGIN_VAULT_DIR)).inferences[0]!;
    await dismissInferenceAction(io, PLUGIN_VAULT_DIR, inf.fingerprint);
    const after = await runResurface(io, PLUGIN_VAULT_DIR, store, registry, "2026-11-15T00:00:02Z", false);
    expect(after).toMatchObject({ reportPath: null, queued: 0 });
  });

  it("빈 그래프는 처음부터 리포트 0 (AC4) — 상태만 전진한다", async () => {
    const { io, store, registry } = await openTestVault();
    const { runResurface } = await import("../src/sync.js");
    const outcome = await runResurface(io, PLUGIN_VAULT_DIR, store, registry, "2026-11-01T00:00:00Z", false);
    expect(outcome).toMatchObject({ reportPath: null, queued: 0 });
    expect(await io.readText(`${PLUGIN_VAULT_DIR}/ontoflow-notes/주간-리포트.md`)).toBeNull();
  });

  it("철회 판정은 사용자 승인 경로다 — 수락이 엣지를 지우고 같은 발견은 다시 서지 않는다 (AC2)", async () => {
    const { io, store, registry } = await contradictedVault();
    const { runResurface } = await import("../src/sync.js");
    const { retractInferenceAction } = await import("../src/screens.js");
    const { loadReviewQueue, pendingItems, projectionDataFor } = await import("../src/core.js");

    await runResurface(io, PLUGIN_VAULT_DIR, store, registry, "2026-11-01T00:00:00Z", false);
    const inf = pendingItems(await loadReviewQueue(io, PLUGIN_VAULT_DIR)).inferences[0]!;
    const before = projectionDataFor(store, "n.md").edges.length;
    await retractInferenceAction(io, PLUGIN_VAULT_DIR, store, registry, inf.fingerprint, 1);
    expect(projectionDataFor(store, "n.md").edges.length).toBe(before - 1);

    // 다음 주기 — 모순이 해소됐고, 해소 전이라도 같은 fingerprint 는 재노출 0.
    const next = await runResurface(io, PLUGIN_VAULT_DIR, store, registry, "2026-11-08T00:00:01Z", true);
    expect(next?.queued).toBe(0);
  });
});


describe("PG 수집함 2단 드레인 (#81 · #439 ③)", () => {
  const twoNotes = [
    { id: "id-1", title: "회의록", md: "# 결정", capturedAt: "2026-11-01T00:00:00Z" },
    { id: "id-2", title: "../탈출", md: "x", capturedAt: "2026-11-01T00:00:01Z" },
  ];

  it("받기 → vault 파일 확정 → 파일로 선 id 만 삭제 확인(ack)이 선다", async () => {
    const vault = fakeVault();
    const io = obsidianFileIo(vault.adapter);
    const acked: string[][] = [];
    const hub = {
      ...noSynthesis,
      canonicalPeekInbox: async () => ({ notes: twoNotes }),
      canonicalAckInbox: async (ids: readonly string[]) => {
        acked.push([...ids]);
      },
    } as unknown as HubClient;
    const { drainPgInbox } = await import("../src/sync.js");
    const { written } = await drainPgInbox(io, PLUGIN_VAULT_DIR, hub, "2026-11-01T00:00:02Z");
    expect(written).toHaveLength(2);
    expect(written[0]).toBe(`${PLUGIN_VAULT_DIR}/ontoflow-inbox/회의록.md`);
    expect(await io.readText(written[0]!)).toBe("# 결정");
    expect(written[1]).not.toContain(".."); // 제목 소독 — 수집함 밖 쓰기 0 (#75 AC6 재사용)
    expect(acked).toEqual([["id-1", "id-2"]]); // ack 는 한 번, 파일로 선 전부
  });

  it("⭐ 파일 쓰기가 중간에 던지면 선 몫만 ack 하고 던진다 — 못 선 캡처는 서버에 남는다 (소실 0)", async () => {
    const vault = fakeVault();
    const io = obsidianFileIo(vault.adapter);
    // 두 번째 쓰기부터 실패하는 io — 디스크 꽉 참·권한 변동 같은 쓰기 루프 중단의 재현.
    let writes = 0;
    const failing = {
      ...io,
      writeText: async (path: string, text: string) => {
        writes += 1;
        if (writes > 1) throw new Error("디스크가 가득 찼다");
        await io.writeText(path, text);
      },
    };
    const acked: string[][] = [];
    const hub = {
      ...noSynthesis,
      canonicalPeekInbox: async () => ({ notes: twoNotes }),
      canonicalAckInbox: async (ids: readonly string[]) => {
        acked.push([...ids]);
      },
    } as unknown as HubClient;
    const { drainPgInbox } = await import("../src/sync.js");
    await expect(drainPgInbox(failing, PLUGIN_VAULT_DIR, hub, "2026-11-01T00:00:02Z")).rejects.toThrow(
      "디스크가 가득 찼다",
    );
    expect(acked).toEqual([["id-1"]]); // 파일로 선 첫 캡처만 확정 — 둘째는 다음 드레인 몫
  });

  it("빈 수신함은 ack 호출 0 이다 — 확정할 것이 없다", async () => {
    const vault = fakeVault();
    const io = obsidianFileIo(vault.adapter);
    const hub = {
      ...noSynthesis,
      canonicalPeekInbox: async () => ({ notes: [] }),
      canonicalAckInbox: async (): Promise<never> => {
        throw new Error("빈 드레인은 ack 를 부르지 않는다");
      },
    } as unknown as HubClient;
    const { drainPgInbox } = await import("../src/sync.js");
    expect((await drainPgInbox(io, PLUGIN_VAULT_DIR, hub, "2026-11-01T00:00:02Z")).written).toEqual([]);
  });
});

describe("수집 유실 0 (#439 ①) — 상태 기록과 처리의 순서", () => {
  const statFor = (body: string, mtime: number) => ({ mtime, size: body.length });

  it("처리 못 한 이벤트를 상태에 박지 않으면 다음 따라잡기가 되줍는다 — 대기열 경로의 불변식", async () => {
    const { io } = await openTestVault();
    const notes = new Map([["a.md", { body: "처음", mtime: 1 }]]);
    await catchUp(io, PLUGIN_VAULT_DIR, fakeReader(notes)); // 기준점 — A 가 상태에 선다
    // 편집이 왔지만 store 준비 전 — 대기열 경로는 collectEvents 를 부르지 않는다(상태 미기록).
    notes.set("a.md", { body: "고침", mtime: 2 });
    const { changes } = await catchUp(io, PLUGIN_VAULT_DIR, fakeReader(notes));
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ note: "a.md", kind: "modified" });
  });

  it("⛔ 반례 — 상태를 먼저 박고 처리가 버려지면 따라잡기도 못 줍는다: 가드가 수집 앞이어야 하는 이유", async () => {
    const { io } = await openTestVault();
    const notes = new Map([["a.md", { body: "처음", mtime: 1 }]]);
    await catchUp(io, PLUGIN_VAULT_DIR, fakeReader(notes));
    // 옛 꼴의 재현: 이벤트가 상태를 먼저 저장하고(collectEvent) 처리(store null)는 버려졌다.
    notes.set("a.md", { body: "고침", mtime: 2 });
    await collectEvent(io, PLUGIN_VAULT_DIR, { kind: "write", path: "a.md", content: "고침", stat: statFor("고침", 2) });
    const { changes } = await catchUp(io, PLUGIN_VAULT_DIR, fakeReader(notes));
    expect(changes).toHaveLength(0); // 「이미 본 것」 — 영구 누락의 실물이었다
  });
});

describe("이벤트 디바운스 (#439 ②)", () => {
  it("묶음 수집은 상태 저장이 1회다 — 이벤트마다 collect.json 재직렬화가 돌지 않는다", async () => {
    const { io } = await openTestVault();
    let stateWrites = 0;
    const counting = {
      ...io,
      writeText: async (path: string, text: string) => {
        if (path.endsWith("collect.json.tmp")) stateWrites += 1;
        await io.writeText(path, text);
      },
    };
    const events: VaultEvent[] = ["a", "b", "c"].map((n, i) => ({
      kind: "write" as const,
      path: `${n}.md`,
      content: `본문 ${n}`,
      stat: { mtime: i + 1, size: `본문 ${n}`.length },
    }));
    const changes = await collectEvents(counting, PLUGIN_VAULT_DIR, events);
    expect(changes).toHaveLength(3);
    expect(stateWrites).toBe(1);
  });

  it("묶음 안 순서가 보존된다 — write→rename 이 낱개 순차와 같은 산출이다", async () => {
    const { io } = await openTestVault();
    const changes = await collectEvents(io, PLUGIN_VAULT_DIR, [
      { kind: "write", path: "a.md", content: "본문", stat: { mtime: 1, size: 2 } },
      { kind: "rename", from: "a.md", to: "b.md", content: "본문", stat: { mtime: 2, size: 2 } },
    ]);
    expect(changes.map((c) => c.kind)).toEqual(["created", "renamed"]);
    expect(changes[1]).toMatchObject({ note: "b.md", renamedFrom: "a.md" });
  });

  it("승격 관찰은 경로별 마지막 원문만 남는다 — rename 은 옮기고 delete 는 걷는다", () => {
    const observed = observedFromEvents([
      { kind: "write", path: "a.md", content: "v1", stat: { mtime: 1, size: 2 } },
      { kind: "write", path: "a.md", content: "v2", stat: { mtime: 2, size: 2 } },
      { kind: "rename", from: "a.md", to: "b.md", content: "v3", stat: { mtime: 3, size: 2 } },
      { kind: "write", path: "c.md", content: "cc", stat: { mtime: 4, size: 2 } },
      { kind: "delete", path: "c.md" },
    ]);
    expect(observed).toEqual([{ path: "b.md", content: "v3" }]);
  });

  it("플러시 지연 — 조용 창이 기본이고, 첫 적체로부터의 상한을 넘기지 않는다 (연속 저장 기아 방지)", () => {
    expect(nextFlushDelay(1_000, 1_000)).toBe(EVENT_QUIET_MS);
    expect(nextFlushDelay(1_000, 1_000 + EVENT_MAX_WAIT_MS - 1_000)).toBe(1_000);
    expect(nextFlushDelay(1_000, 1_000 + EVENT_MAX_WAIT_MS + 5_000)).toBe(0);
  });
});

// 거래 고지 운반 (ISSUE-362) — 서버 200 의 notices 가 HubDispatch 로 실려 플러그인 Notice 채널에
// 닿는다: #193 AC12 「API 응답」 채널의 복구다 (버리면 고지 의무 반쪽).
describe("거래 고지 운반 (ISSUE-362)", () => {
  it("응답의 notices 가 dispatch 로 실리고, 없으면 빈 목록이다", async () => {
    const { io, store, registry } = await openTestVault();
    await grantAll(io);
    const hub = {
      ...noSynthesis,
      extractIncremental: async () => ({
        add: [],
        retract: [],
        proposals: [],
        held: [],
        aliases: [],
        merges: [],
        notices: ["usage-80"],
      }),
      extractReindex: async (): Promise<never> => {
        throw new Error("이 테스트는 재색인을 부르지 않는다");
      },
    } as unknown as HubClient;
    const dispatch = await sendToHub(io, PLUGIN_VAULT_DIR, store, registry, hub, [
      { kind: "write", note: "a.md", diff: "@@\n+한 줄." },
    ] as never);
    expect(dispatch.notices).toEqual(["usage-80"]);
  });
});

describe("투영 편집 승격 배선 (ISSUE-430 — #10 AC18·AC3 「사용자 편집 항상 승」)", () => {
  it("블록만 고친 저장(수집 산출 0)이 by:user 로 승격되고, 재투영·재추출이 그 값을 지킨다", async () => {
    const { io, store, registry } = await openTestVault();
    const { applyPatch, parseProjection } = await import("../src/core.js");
    const note = "수면.md";
    const auto = (confidence: number) => ({
      s: "수면",
      v: "causes",
      o: "입면 지연",
      confidence,
      fallback: false,
      by: "auto" as const,
      src: { note, origin: "extract" as const },
    });
    await applyPatch(store, registry, { add: [auto(0.9)], retract: [] });
    await io.writeText(note, "수면에 관한 노트.");
    expect((await projectNoteCommand(io, PLUGIN_VAULT_DIR, store, note)).changed).toBe(true);

    const projected = (await io.readText(note)) ?? "";
    // 투영된 그대로를 한 번 수집해 추적을 세운다 — 다음 저장의 「산출 0」이 실측되게.
    await collectEvent(io, PLUGIN_VAULT_DIR, {
      kind: "write",
      path: note,
      content: projected,
      stat: { mtime: 1, size: projected.length },
    });
    const edited = projected.replace("confidence: 0.9", "confidence: 0.4");
    expect(edited).not.toBe(projected);
    const change = await collectEvent(io, PLUGIN_VAULT_DIR, {
      kind: "write",
      path: note,
      content: edited,
      stat: { mtime: 2, size: edited.length },
    });
    expect(change).toBeNull(); // 본문(투영 제거본) 무변 — 수집에 매달면 바로 이 저장이 소실된다

    const patch = await promoteProjectionEdits(store, registry, note, edited);
    expect(patch).not.toBeNull();
    expect(projectionDataFor(store, note).edges[0]).toMatchObject({ by: "user", confidence: 0.4 });

    // 재투영이 승격 값을 되비춘다 — 편집이 소리 없이 되덮이던 옛 경로의 역전.
    await projectNoteCommand(io, PLUGIN_VAULT_DIR, store, note);
    const reread = parseProjection((await io.readText(note)) ?? "");
    expect(reread?.edges[0]).toMatchObject({ by: "user", confidence: 0.4 });

    // 재추출(auto)이 같은 논리 엣지를 밀어도 사용자 승이 막는다.
    const re = await applyPatch(store, registry, { add: [auto(0.95)], retract: [] });
    expect(re.skipped).toBe(1);
    expect(projectionDataFor(store, note).edges[0]).toMatchObject({ by: "user", confidence: 0.4 });
  });

  it("블록 없음(투영 전)·무변 블록은 승격 0 이다", async () => {
    const { io, store, registry } = await openTestVault();
    const { applyPatch } = await import("../src/core.js");
    expect(await promoteProjectionEdits(store, registry, "없음.md", "그냥 본문")).toBeNull();
    const note = "수면.md";
    await applyPatch(store, registry, {
      add: [
        {
          s: "수면",
          v: "causes",
          o: "입면 지연",
          confidence: 0.9,
          fallback: false,
          by: "auto",
          src: { note, origin: "extract" },
        },
      ],
      retract: [],
    });
    await io.writeText(note, "본문.");
    await projectNoteCommand(io, PLUGIN_VAULT_DIR, store, note);
    const untouched = (await io.readText(note)) ?? "";
    expect(await promoteProjectionEdits(store, registry, note, untouched)).toBeNull(); // 무변 — 패치 0
  });
});

describe("따라잡기 승격 (ISSUE-451 — #430 의 catchUp 잔여: 꺼진 동안의 블록 편집)", () => {
  it("블록만 고친 노트: 수집 산출 0 이어도 observed 로 돌아와 by:user 승격·재투영이 지킨다", async () => {
    const { io, store, registry } = await openTestVault();
    const { applyPatch, parseProjection } = await import("../src/core.js");
    const note = "수면.md";
    await applyPatch(store, registry, {
      add: [
        {
          s: "수면",
          v: "causes",
          o: "입면 지연",
          confidence: 0.9,
          fallback: false,
          by: "auto",
          src: { note, origin: "extract" },
        },
      ],
      retract: [],
    });
    await io.writeText(note, "수면에 관한 노트.");
    await projectNoteCommand(io, PLUGIN_VAULT_DIR, store, note);
    const projected = (await io.readText(note)) ?? "";

    // 추적 세움 — 투영된 그대로를 따라잡기 한 판으로 수집 상태에 박는다.
    const notes = new Map([[note, { body: projected, mtime: 1 }]]);
    await catchUp(io, PLUGIN_VAULT_DIR, fakeReader(notes));

    // 꺼진 동안의 블록만 편집 — 본문(투영 제거본)은 무변이다.
    const edited = projected.replace("confidence: 0.9", "confidence: 0.4");
    expect(edited).not.toBe(projected);
    notes.set(note, { body: edited, mtime: 2 });

    const { changes, observed } = await catchUp(io, PLUGIN_VAULT_DIR, fakeReader(notes));
    expect(changes).toHaveLength(0); // 수집 산출 0 — 여기 매달면 바로 이 편집이 소실된다
    expect(observed).toEqual([{ path: note, content: edited }]); // 원문이 승격 입력으로 돌아온다

    // 배선과 같은 순서 — observed 원문이 그대로 승격을 탄다 (main.processChanges 의 루프).
    expect(await promoteProjectionEdits(store, registry, note, edited)).not.toBeNull();
    expect(projectionDataFor(store, note).edges[0]).toMatchObject({ by: "user", confidence: 0.4 });

    // 재투영 생존 — 편집이 소리 없이 되덮이던 옛 catchUp 경로의 역전.
    await projectNoteCommand(io, PLUGIN_VAULT_DIR, store, note);
    const reread = parseProjection((await io.readText(note)) ?? "");
    expect(reread?.edges[0]).toMatchObject({ by: "user", confidence: 0.4 });
  });

  it("선별은 stat 규율 그대로다 — 무변 재독 0 · 본문 변경은 수집 산출과 공존 · 삭제는 관찰 0", async () => {
    const { io } = await openTestVault();
    const notes = new Map([
      ["무변.md", { body: "그대로인 본문.", mtime: 1 }],
      ["본문변경.md", { body: "고치기 전 본문.", mtime: 1 }],
      ["삭제.md", { body: "사라질 본문.", mtime: 1 }],
    ]);
    await catchUp(io, PLUGIN_VAULT_DIR, fakeReader(notes));

    notes.set("본문변경.md", { body: "고친 뒤 본문.", mtime: 2 });
    notes.delete("삭제.md"); // read 가 던지는 가짜 리더다 — 관찰이 삭제를 재독하면 여기서 터진다
    notes.set("신규.md", { body: "꺼진 동안 생긴 노트.", mtime: 2 });
    const base = fakeReader(notes);
    const reads: string[] = [];
    const counting = {
      list: base.list,
      read: async (path: string) => {
        reads.push(path);
        return base.read(path);
      },
    };

    const { changes, observed } = await catchUp(io, PLUGIN_VAULT_DIR, counting);
    expect(changes.map((c) => `${c.kind}:${c.note}`).sort()).toEqual([
      "created:신규.md",
      "deleted:삭제.md",
      "modified:본문변경.md",
    ]);
    // 본문도 바뀐 파일은 수집 산출과 공존하고(승격 먼저·디프는 제거본 기준), 신규도 관찰된다
    // (라이브 생성 이벤트와 등가 — 블록째 복제된 노트가 이 자리로 온다).
    expect(observed.map((o) => o.path).sort()).toEqual(["본문변경.md", "신규.md"]);
    expect(reads.filter((p) => p === "무변.md")).toHaveLength(0); // stat 무변 — 재독 0 (AC6 무변)
  });
});
