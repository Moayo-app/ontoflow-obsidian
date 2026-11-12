import { describe, expect, it } from "vitest";
import {
  SENSITIVE_CONSENT_TEXT,
  applyPatch,
  chooseVault,
  connectHub,
  emptyOnboarding,
  enqueueMerges,
  enqueueTypings,
  grantConsent,
  loadDictionary,
  loadReviewQueue,
  observeVerbs,
  openVault,
  projectionDataFor,
  saveReviewQueue,
  startInitialIndex,
} from "../src/core.js";
import { PLUGIN_VAULT_DIR, obsidianFileIo } from "../src/obsidian-io.js";
import { loadRegistryFile } from "../src/registry-io.js";
import {
  acceptMergeAction,
  acceptTypingAction,
  confirmVerbAction,
  onboardingView,
  rejectMergeAction,
  rejectTypingAction,
  rejectVerbAction,
  reviewView,
  updateOnboarding,
} from "../src/screens.js";
import { fakeVault } from "./fakes.js";

async function openTestVault() {
  const io = obsidianFileIo(fakeVault().adapter);
  const store = await openVault(io, PLUGIN_VAULT_DIR);
  const registry = await loadRegistryFile(io, PLUGIN_VAULT_DIR);
  return { io, store, registry };
}

describe("S1 온보딩 뷰모델 (이슈 #42 AC2)", () => {
  it("동의 전 「색인 시작」 비활성 — 문안은 `§23` 동의문 그대로다", () => {
    const before = onboardingView(emptyOnboarding());
    expect(before.canStartIndex).toBe(false);
    expect(before.consentText).toBe(SENSITIVE_CONSENT_TEXT);
    // 허브·vault 가 돼도 동의 전에는 비활성이고, 시작 함수 자체가 선다
    const almost = chooseVault(connectHub(emptyOnboarding()));
    expect(onboardingView(almost).canStartIndex).toBe(false);
    expect(() => startInitialIndex(almost, 5)).toThrow(/동의/);
    const ready = grantConsent(almost, "2026-11-01T00:00:00Z");
    expect(onboardingView(ready).canStartIndex).toBe(true);
  });

  it("전이 영속 — updateOnboarding 가 저장까지 잇는다", async () => {
    const { io } = await openTestVault();
    await updateOnboarding(io, PLUGIN_VAULT_DIR, connectHub);
    const state = await updateOnboarding(io, PLUGIN_VAULT_DIR, chooseVault);
    expect(state.hubConnected).toBe(true);
    expect(state.vaultChosen).toBe(true);
    expect(onboardingView(state).canStartIndex).toBe(false); // 동의는 아직
  });
});

describe("S2 검토함 — 수락·기각만이 정본을 움직인다 (이슈 #42 AC6)", () => {
  it("병합 수락 → 별칭 박제 · 기각 → 분리 박제, 행동 전에는 영원히 pending 이다", async () => {
    const { io, store, registry } = await openTestVault();
    await applyPatch(store, registry, {
      add: [
        {
          s: "에픽테토스",
          v: "related-to",
          o: "스토아 철학",
          confidence: 0.5,
          fallback: true,
          by: "auto",
          src: { note: "스토아.md", origin: "wikilink" },
        },
      ],
      retract: [],
    });
    const queue = enqueueMerges(await loadReviewQueue(io, PLUGIN_VAULT_DIR), [
      { kind: "merge", name: "엡틱테토스", node: "에픽테토스", confidence: 0.82 },
      { kind: "merge", name: "스토아철학", node: "스토아 철학", confidence: 0.75 },
    ]);
    await saveReviewQueue(io, PLUGIN_VAULT_DIR, queue);
    // 자동 수락 0 — 다시 읽어도 pending 그대로다
    expect((await reviewView(io, PLUGIN_VAULT_DIR)).merges).toHaveLength(2);

    await acceptMergeAction(io, PLUGIN_VAULT_DIR, store, "엡틱테토스", "에픽테토스");
    expect(loadDictionary(store).nodes.find((n) => n.name === "에픽테토스")?.aliases).toContain(
      "엡틱테토스",
    );

    await rejectMergeAction(io, PLUGIN_VAULT_DIR, store, "스토아철학", "스토아 철학");
    expect(loadDictionary(store).distinctions).toContainEqual(["스토아 철학", "스토아철학"]);

    expect((await reviewView(io, PLUGIN_VAULT_DIR)).merges).toHaveLength(0);
    // 같은 확정의 중복 호출은 선다 — 두 번 수락되는 길이 없다
    await expect(
      acceptMergeAction(io, PLUGIN_VAULT_DIR, store, "엡틱테토스", "에픽테토스"),
    ).rejects.toThrow(/이미 확정/);
  });

  it("타이핑 수락 → 폴백 엣지가 사람 동사(by:user)로 바뀐다 · 기각은 정본 무변이다", async () => {
    const { io, store, registry } = await openTestVault();
    await applyPatch(store, registry, {
      add: [
        {
          s: "리허설 부족",
          v: "related-to",
          o: "긴장",
          confidence: 0.5,
          fallback: true,
          by: "auto",
          src: { note: "회고.md", origin: "wikilink" },
        },
        {
          s: "긴장",
          v: "related-to",
          o: "말이 꼬임",
          confidence: 0.5,
          fallback: true,
          by: "auto",
          src: { note: "회고.md", origin: "wikilink" },
        },
      ],
      retract: [],
    });
    const queue = enqueueTypings(await loadReviewQueue(io, PLUGIN_VAULT_DIR), [
      { kind: "typing", s: "리허설 부족", o: "긴장", note: "회고.md" },
      { kind: "typing", s: "긴장", o: "말이 꼬임", note: "회고.md" },
    ]);
    await saveReviewQueue(io, PLUGIN_VAULT_DIR, queue);

    await acceptTypingAction(io, PLUGIN_VAULT_DIR, store, registry, "리허설 부족", "긴장", "회고.md", "causes");
    const typed = projectionDataFor(store, "회고.md").edges.find((e) => e.s === "리허설 부족");
    expect(typed).toMatchObject({ v: "causes", by: "user", fallback: false });

    await rejectTypingAction(io, PLUGIN_VAULT_DIR, "긴장", "말이 꼬임", "회고.md");
    const still = projectionDataFor(store, "회고.md").edges.find((e) => e.s === "긴장");
    expect(still).toMatchObject({ v: "related-to", fallback: true }); // 기각은 정본 무변

    expect((await reviewView(io, PLUGIN_VAULT_DIR)).typings).toHaveLength(0);
  });

  it("동사 확정 → 등록부 버전 업(재색인 트리거) · 기각 → 박제", async () => {
    const { io } = await openTestVault();
    let queue = await loadReviewQueue(io, PLUGIN_VAULT_DIR);
    queue = observeVerbs(queue, [
      { verbRaw: "대표한다", superclassHint: "연관", note: "a.md" },
      { verbRaw: "대표한다", superclassHint: "연관", note: "b.md" },
      { verbRaw: "스친다", note: "c.md" },
      { verbRaw: "스친다", note: "d.md" },
    ]);
    await saveReviewQueue(io, PLUGIN_VAULT_DIR, queue);
    expect((await reviewView(io, PLUGIN_VAULT_DIR)).verbs).toHaveLength(2); // 임계 2 로 제안 승격

    const registry = await confirmVerbAction(io, PLUGIN_VAULT_DIR, "대표한다", {
      id: "represents",
      label: "대표한다",
      superclass: "연관",
    });
    expect(registry.version).toBe(2);
    expect(registry.verbs.some((v) => v.id === "represents")).toBe(true);
    // 파일에도 섰다 — 다음 로드가 새 버전을 본다
    expect((await loadRegistryFile(io, PLUGIN_VAULT_DIR)).version).toBe(2);

    await rejectVerbAction(io, PLUGIN_VAULT_DIR, "스친다");
    expect((await reviewView(io, PLUGIN_VAULT_DIR)).verbs).toHaveLength(0);
  });
});
