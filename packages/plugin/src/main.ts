// 옵시디언 진입점 — 조립만 한다: 수집(F1) 배선 · S1/S2 화면 · 커맨드 · 설정 (이슈 #42).
// 판단은 전부 코어와 뷰모델(screens·sync·commands)에 있다 — 이 파일은 옵시디언 API 와의 접착뿐이다.
import { Modal, Notice, Plugin, PluginSettingTab, Setting, TFile, type App } from "obsidian";
import {
  FALLBACK_VERB_ID,
  SOURCE_KINDS,
  SUPERCLASSES,
  chooseVault,
  collectRegisteredSources,
  firstIndexHighlights,
  connectHub,
  bearSourceReader,
  designateHome,
  designateSynthesisDir,
  openSqlDatabase,
  readBearNotes,
  grantConsent,
  loadSynthesisState,
  saveSynthesisState,
  loadDictionary,
  loadOnboarding,
  openVault,
  registerSource,
  removeSourceState,
  unregisterSource,
  type CollectedChange,
  type FileIo,
  type IngestSource,
  type SourceReader,
  type GraphStore,
  type SourceKind,
  type Superclass,
  type VaultReader,
} from "./core.js";
import { hubClient, type Extractor, type HubClient } from "./hub-client.js";
import { obsidianFetch } from "./net.js";
import { configureEmbeddedSqlJs } from "./sql-wasm.js";
import { PLUGIN_VAULT_DIR, obsidianFileIo } from "./obsidian-io.js";
import { bearDbPath, isMacDesktop, nodeBearFs, readBearDbBytes } from "./bear-io.js";
import { folderSourceReader, nodeFolderFs } from "./source-io.js";
import { loadRegistryFile } from "./registry-io.js";
import {
  retractInferenceAction,
  dismissInferenceAction,
  acceptMergeAction,
  acceptTypingAction,
  confirmVerbAction,
  onboardingView,
  rejectMergeAction,
  rejectTypingAction,
  rejectVerbAction,
  reviewView,
  updateOnboarding,
} from "./screens.js";
import { DEFAULT_SETTINGS, byoEndpointOf, parseSettings, type PluginSettings } from "./settings.js";
import {
  drainPgInbox,
  runResurface,
  applyLocal,
  catchUp,
  collectEvent,
  extractorFor,
  flushPgCanonical,
  holdForLater,
  loadPgCanonical,
  runInitialIndex,
  runSynthesis,
  sendToHub,
  takeHeld,
} from "./sync.js";
import { EXPORT_FILES, exportCommand, projectNoteCommand, type ExportFormat } from "./commands.js";

export default class OntoFlowPlugin extends Plugin {
  settings: PluginSettings = DEFAULT_SETTINGS;
  io!: FileIo;
  store: GraphStore | null = null;
  /** PG 정본(#63)의 낙관적 잠금 카운터 — sqlite 모드에서는 쓰지 않는다. */
  canonicalRev = 0;

  override async onload(): Promise<void> {
    this.settings = parseSettings(await this.loadData());
    this.io = obsidianFileIo(this.app.vault.adapter);

    // sql.js wasm 주입 (#49 자리 · #105 내장) — 번들 런타임은 wasm 을 스스로 못 찾는다.
    // 바이트는 번들 안에 산다: 마켓 설치본에는 플러그인 디렉터리의 네 번째 파일이 없다
    // (설치기는 main.js·manifest.json·styles.css 만 내려받는다). 첫 openVault 전이어야 한다.
    configureEmbeddedSqlJs();

    this.addSettingTab(new OntoFlowSettingTab(this.app, this));
    // 커맨드 id 에 플러그인 id 를 붙이지 않는다 — 옵시디언이 `ontoflow:` 를 자동으로 앞에
    // 세운다(중복 접두 방지). 이름에도 플러그인 이름·내부 식별자(S1·S2)를 싣지 않는다.
    this.addCommand({
      id: "open-onboarding",
      name: "온보딩",
      callback: () => new OnboardingModal(this.app, this).open(),
    });
    this.addCommand({
      id: "open-review",
      name: "검토함",
      callback: () => new ReviewModal(this.app, this).open(),
    });
    this.addCommand({
      id: "project-active-note",
      name: "현재 노트 투영",
      callback: () => void this.projectActiveNote(),
    });
    this.addCommand({
      id: "export-jsonld",
      name: "JSON-LD 내보내기",
      callback: () => void this.export("jsonld"),
    });
    this.addCommand({
      id: "export-graphml",
      name: "GraphML 내보내기",
      callback: () => void this.export("graphml"),
    });
    this.addCommand({
      id: "retry-held",
      name: "보류된 추출 재시도",
      callback: () => void this.retryHeld(),
    });
    this.addCommand({
      id: "collect-sources",
      name: "수집 소스 따라잡기",
      callback: () => void this.collectSources(true),
    });
    this.addCommand({
      id: "synthesize-sources",
      name: "소스 정리 노트 합성",
      callback: () => void this.synthesizeSources(this.settings.sources.map((s) => s.id), true),
    });
    this.addCommand({
      id: "weekly-report",
      name: "주간 리포트 지금 만들기",
      callback: () => void this.resurfaceCycle(true),
    });

    // 수집 이벤트는 레이아웃이 선 뒤에 건다 — 시작 시의 일괄 create 이벤트는 따라잡기가 담당한다.
    this.app.workspace.onLayoutReady(() => {
      void this.startUp();
      this.registerEvent(
        this.app.vault.on("modify", (file) => {
          if (file instanceof TFile && file.extension === "md") void this.onWrite(file);
        }),
      );
      this.registerEvent(
        this.app.vault.on("create", (file) => {
          if (file instanceof TFile && file.extension === "md") void this.onWrite(file);
        }),
      );
      this.registerEvent(
        this.app.vault.on("delete", (file) => {
          if (file instanceof TFile && file.extension === "md") {
            void this.onEvent({ kind: "delete", path: file.path });
          }
        }),
      );
      this.registerEvent(
        this.app.vault.on("rename", (file, oldPath) => {
          if (file instanceof TFile && file.extension === "md") void this.onRename(file, oldPath);
        }),
      );
    });
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  // 전송은 전부 requestUrl 이다 (#105) — fetch 는 플러그인 출처에서 CORS 를 받는다: 특히
  // BYO 로컬 엔드포인트가 차단돼 「본문이 기기를 떠나지 않는다」는 길이 서지 않는다.
  hub(): HubClient {
    return hubClient(this.settings.hubBaseUrl, async () => this.settings.hubToken, obsidianFetch);
  }

  /** 추출기 선택 (#88) — BYO 가 서 있으면 로컬 직행, 아니면 허브. 추출 외 허브 왕복은 hub() 그대로다. */
  extractor(): Extractor {
    return extractorFor(byoEndpointOf(this.settings), this.hub(), obsidianFetch);
  }

  reader(): VaultReader {
    return {
      list: async () =>
        this.app.vault
          .getMarkdownFiles()
          .map((f) => ({ path: f.path, mtime: f.stat.mtime, size: f.stat.size })),
      read: async (path) => {
        const file = this.app.vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile)) throw new Error(`노트가 아니다: ${path}`);
        return this.app.vault.cachedRead(file);
      },
    };
  }

  private async startUp(): Promise<void> {
    try {
      this.store = await openVault(this.io, PLUGIN_VAULT_DIR);
      // PG 정본 (#63) — 정본은 사용자 PG: 시작 시 적재가 로컬 사본(graph.sqlite·registry.yml)을
      // 덮는다 (정본 승). 적재 실패는 안전 정지 — 로컬 사본으로 쓰기 작업을 잇지 않는다 (AC5).
      if (this.settings.canonical === "pg") {
        const handle = await loadPgCanonical(this.io, PLUGIN_VAULT_DIR, this.hub());
        this.store = handle.store;
        this.canonicalRev = handle.rev;
        // 원격 MCP 캡처 내리기 (#81) — vault 파일로 선 것만 서버에서 지워지므로 소실 0.
        // 실패는 치명이 아니다: 캡처는 PG 수집함에 그대로 남아 다음 드레인을 기다린다.
        try {
          const { written } = await drainPgInbox(this.io, PLUGIN_VAULT_DIR, this.hub(), new Date().toISOString());
          if (written.length > 0) new Notice(`원격 캡처 ${written.length}건이 수집함으로 내려왔다`);
        } catch (e) {
          new Notice(`수집함 내리기 실패(캡처는 PG 에 남아 있다): ${(e as Error).message}`);
        }
      }
      const changes = await catchUp(this.io, PLUGIN_VAULT_DIR, this.reader());
      await this.processChanges(changes);
    } catch (e) {
      this.store = this.settings.canonical === "pg" ? null : this.store; // 반쪽 연결 0
      new Notice(`OntoFlow 시작 실패: ${(e as Error).message}`);
    }
    await this.collectSources(false);
  }

  // PG 정본 반영 (#63) — 변경을 일으킨 호출자가 끝에서 부른다. 409(rev 가드)는 다른 자리의
  // 반영이 먼저 선 것 — 임의 병합 없이 재적재를 안내한다 (AC5).
  async persistCanonical(): Promise<void> {
    if (this.settings.canonical !== "pg" || this.store === null) return;
    try {
      this.canonicalRev = await flushPgCanonical(this.io, PLUGIN_VAULT_DIR, this.hub(), this.store, this.canonicalRev);
    } catch (e) {
      new Notice(`PG 정본 반영 실패: ${(e as Error).message} — 플러그인 재시작으로 재적재하라`);
    }
  }

  // 수집 소스 따라잡기 (#55) — 소스는 vault 이벤트가 없어 언제나 스냅샷 대조다: 시작 시 한 번 +
  // 커맨드 수동. 산출은 vault 수집과 같은 파이프라인(processChanges)에 탄다 (AC1).
  private async collectSources(verbose: boolean): Promise<void> {
    if (this.settings.sources.length === 0 || this.store === null) {
      if (verbose) new Notice("등록된 수집 소스가 없다");
      return;
    }
    try {
      const fs = nodeFolderFs(); // 모바일이면 여기서 명시 오류 — 조용한 0 수집은 없다
      // Bear(#58)는 DB 바이트를 한 번 떠서 리더로 편다 — macOS 밖·미설치는 수집 전에 걸러
      // 무해한 안내로 선다 (AC4: 반쯤 연결 0). 리더 조립은 등록된 소스에만 닿는다 (AC4 of #55).
      const readers = new Map<string, SourceReader>();
      const collectable: IngestSource[] = [];
      for (const s of this.settings.sources) {
        if (s.kind !== "bear") {
          collectable.push(s);
          readers.set(s.id, folderSourceReader(s.root, fs));
          continue;
        }
        if (!isMacDesktop()) {
          new Notice(`Bear 수집(${s.id})은 macOS 전용이다 — 이 기기에서는 쉰다`);
          continue;
        }
        const bear = nodeBearFs();
        const path = s.root.trim() === "" || s.root === "(기본 자리)" ? bearDbPath(bear.homedir) : s.root;
        const bytes = await readBearDbBytes(bear.fs, path);
        if (bytes === null) {
          new Notice(`Bear 를 찾지 못했다(${s.id}) — 설치·권한을 확인하라: ${path}`);
          continue;
        }
        const db = await openSqlDatabase(bytes);
        try {
          const notes = readBearNotes(db);
          if (notes.encryptedSkipped > 0) {
            new Notice(`Bear 암호화 노트 ${notes.encryptedSkipped}건은 수집하지 않는다`);
          }
          readers.set(s.id, bearSourceReader(notes));
          collectable.push(s);
        } finally {
          db.close();
        }
      }
      const changes = await collectRegisteredSources(this.io, PLUGIN_VAULT_DIR, collectable, (s) => {
        const reader = readers.get(s.id);
        if (!reader) throw new Error(`리더가 없는 소스다: ${s.id}`);
        return reader;
      });
      await this.processChanges(changes);
      if (verbose) new Notice(`소스 ${this.settings.sources.length}곳 — 변경 ${changes.length}건 수집`);
      // 수집 완료 → 소스 단위 합성 갱신 (#59 트리거) — 변경이 있던 소스만.
      const changedSources = [...new Set(changes.map((c) => c.note.split(":/")[0] ?? ""))].filter((s) => s !== "");
      await this.synthesizeSources(changedSources, false);
    } catch (e) {
      new Notice(`소스 수집 실패: ${(e as Error).message}`);
    }
  }

  // 합성 갱신 (#59) — 소스 단위. 동의 전·그래프 없음은 runSynthesis 가 명시 오류로 세운다.
  private async synthesizeSources(sourceIds: readonly string[], verbose: boolean): Promise<void> {
    if (this.store === null || sourceIds.length === 0) {
      if (verbose) new Notice("합성할 소스가 없다");
      return;
    }
    for (const sourceId of sourceIds) {
      try {
        const { path } = await runSynthesis(this.io, PLUGIN_VAULT_DIR, this.store, this.hub(), sourceId, new Date().toISOString());
        await this.persistCanonical(); // 합성은 그래프를 바꾸지 않지만 투영 상태가 움직일 수 있다
        if (verbose) new Notice(`합성했다: ${path}`);
      } catch (e) {
        new Notice(`합성 실패 (${sourceId}): ${(e as Error).message}`);
      }
    }
  }

  private async onWrite(file: TFile): Promise<void> {
    const content = await this.app.vault.cachedRead(file);
    await this.onEvent({
      kind: "write",
      path: file.path,
      content,
      stat: { mtime: file.stat.mtime, size: file.stat.size },
    });
  }

  private async onRename(file: TFile, oldPath: string): Promise<void> {
    const content = await this.app.vault.cachedRead(file);
    await this.onEvent({
      kind: "rename",
      from: oldPath,
      to: file.path,
      content,
      stat: { mtime: file.stat.mtime, size: file.stat.size },
    });
  }

  private async onEvent(
    event: Parameters<typeof collectEvent>[2],
  ): Promise<void> {
    try {
      const change = await collectEvent(this.io, PLUGIN_VAULT_DIR, event);
      await this.processChanges(change ? [change] : []);
    } catch (e) {
      new Notice(`OntoFlow 수집 실패: ${(e as Error).message}`);
    }
  }

  private async processChanges(changes: CollectedChange[]): Promise<void> {
    if (changes.length === 0 || this.store === null) return;
    const onboarding = await loadOnboarding(this.io, PLUGIN_VAULT_DIR);
    // `§23` 동의 전 — 추출도 보류 적재도 없다 (AC2). 동의 뒤의 최초 색인이 전량을 따라잡는다.
    if (onboarding.consent === null) return;
    const registry = await loadRegistryFile(this.io, PLUGIN_VAULT_DIR);
    await applyLocal(this.io, PLUGIN_VAULT_DIR, this.store, registry, changes);
    try {
      await sendToHub(this.io, PLUGIN_VAULT_DIR, this.store, registry, this.extractor(), changes);
    } catch {
      // 허브가 안 닿는다 — 추출 몫만 쌓인다 (#12 AC5). 로컬 효과는 이미 섰다.
      await holdForLater(this.io, PLUGIN_VAULT_DIR, changes);
    }
    await this.persistCanonical(); // PG 정본 (#63) — 변경 반영
    await this.resurfaceCycle(false); // 재부상 (#80) — 주기가 지났을 때만 돈다 (편승, 크론 0)
  }

  // 재부상 한 판 (#80) — 판정·큐 적재·리포트. 실패는 수집을 막지 않는다 (알림만).
  private async resurfaceCycle(force: boolean): Promise<void> {
    if (this.store === null) return;
    try {
      const registry = await loadRegistryFile(this.io, PLUGIN_VAULT_DIR);
      const outcome = await runResurface(this.io, PLUGIN_VAULT_DIR, this.store, registry, new Date().toISOString(), force);
      if (outcome === null) {
        if (force) new Notice("재부상 주기 미도래 — 강제 실행 오류다 (버그)");
        return;
      }
      if (outcome.reportPath !== null) {
        new Notice(`주간 리포트가 섰다: ${outcome.reportPath}${outcome.queued > 0 ? ` · 판정 대기 +${outcome.queued}` : ""}`);
      } else if (force) {
        new Notice("할 말이 없다 — 새 변화·모순·공백 0 (리포트 생략)");
      }
    } catch (e) {
      new Notice(`재부상 실패: ${(e as Error).message}`);
    }
  }

  private async retryHeld(): Promise<void> {
    if (this.store === null) return;
    const items = await takeHeld(this.io, PLUGIN_VAULT_DIR);
    if (items.length === 0) {
      new Notice("보류된 추출이 없다");
      return;
    }
    const registry = await loadRegistryFile(this.io, PLUGIN_VAULT_DIR);
    try {
      const r = await sendToHub(this.io, PLUGIN_VAULT_DIR, this.store, registry, this.extractor(), items);
      await this.persistCanonical();
      new Notice(`보류 ${items.length}건 처리 — 엣지 +${r.patch.added}`);
    } catch (e) {
      await holdForLater(this.io, PLUGIN_VAULT_DIR, items); // 실패분은 되돌린다
      new Notice(`허브가 아직 안 닿는다: ${(e as Error).message}`);
    }
  }

  private async projectActiveNote(): Promise<void> {
    const file = this.app.workspace.getActiveFile();
    if (!file || this.store === null) {
      new Notice("투영할 노트가 없다");
      return;
    }
    try {
      const { changed } = await projectNoteCommand(this.io, PLUGIN_VAULT_DIR, this.store, file.path);
      new Notice(changed ? `투영했다: ${file.path}` : "무변 — 쓰지 않았다");
    } catch (e) {
      new Notice(`투영 실패: ${(e as Error).message}`);
    }
  }

  private async export(format: ExportFormat): Promise<void> {
    if (this.store === null) {
      new Notice("정본이 아직 열리지 않았다");
      return;
    }
    try {
      const registry = await loadRegistryFile(this.io, PLUGIN_VAULT_DIR);
      await exportCommand(this.io, PLUGIN_VAULT_DIR, this.store, registry, format);
      new Notice(`내보냈다: ${EXPORT_FILES[format]}`);
    } catch (e) {
      new Notice(`내보내기 실패: ${(e as Error).message}`);
    }
  }
}

// ---- S1 — 온보딩 모달: 허브 연결 → vault 선택 → `§23` 동의 → 최초 색인 (동의 전 시작 비활성, AC2) ----

class OnboardingModal extends Modal {
  constructor(
    app: App,
    private readonly plugin: OntoFlowPlugin,
  ) {
    super(app);
  }

  override onOpen(): void {
    void this.render();
  }

  private async render(): Promise<void> {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "OntoFlow 온보딩" });
    const view = onboardingView(await loadOnboarding(this.plugin.io, PLUGIN_VAULT_DIR));

    new Setting(contentEl)
      .setName(`허브 연결 ${view.hubConnected ? "✓" : "— 전"}`)
      .setDesc("설정 탭에서 허브 주소·토큰을 먼저 넣는다.")
      .addButton((b) =>
        b
          .setButtonText("연결 확인")
          .setDisabled(
            view.hubConnected ||
              this.plugin.settings.hubBaseUrl === "" ||
              this.plugin.settings.hubToken === null,
          )
          .onClick(async () => {
            await updateOnboarding(this.plugin.io, PLUGIN_VAULT_DIR, connectHub);
            await this.render();
          }),
      );

    new Setting(contentEl).setName(`vault 선택 ${view.vaultChosen ? "✓" : "— 전"}`).addButton((b) =>
      b
        .setButtonText("이 vault 사용")
        .setDisabled(view.vaultChosen)
        .onClick(async () => {
          await updateOnboarding(this.plugin.io, PLUGIN_VAULT_DIR, chooseVault);
          await this.render();
        }),
    );

    contentEl.createEl("p", { text: view.consentText });
    new Setting(contentEl).setName(`민감정보 별도 동의 ${view.consentGranted ? "✓" : "— 전"}`).addButton((b) =>
      b
        .setButtonText("동의한다")
        .setDisabled(view.consentGranted)
        .onClick(async () => {
          await updateOnboarding(this.plugin.io, PLUGIN_VAULT_DIR, (s) =>
            grantConsent(s, new Date().toISOString()),
          );
          await this.render();
        }),
    );

    new Setting(contentEl)
      .setName(`최초 색인 — ${view.progress}${view.completed ? " (완료)" : ""}`)
      .addButton((b) =>
        b
          .setButtonText("색인 시작")
          .setDisabled(!view.canStartIndex) // AC2 — 동의 전 비활성
          .onClick(async () => {
            try {
              const registry = await loadRegistryFile(this.plugin.io, PLUGIN_VAULT_DIR);
              const result = await runInitialIndex(
                this.plugin.io,
                PLUGIN_VAULT_DIR,
                this.plugin.reader(),
                registry,
                this.plugin.extractor(),
                new Date().toISOString(),
                // 기존 별칭·분리 판정을 재색인 정규화에 싣는다 (#47) — 정본이 아직 없으면 생략
                this.plugin.store === null ? undefined : loadDictionary(this.plugin.store),
              );
              this.plugin.store = result.store; // 재색인은 정본 원자 교체 — 열린 핸들을 바꾼다
              new Notice(
                `최초 색인 완료 — 노트 ${result.total}` +
                  (result.held.length > 0 ? ` · 보류 ${result.held.length}` : ""),
              );
            } catch (e) {
              new Notice(`색인 실패: ${(e as Error).message}`);
            }
            await this.render();
          }),
      );

    // ---- 첫 색인 하이라이트 (#89) — 「그래프를 보라」가 아니라 「이게 네 노트에서 나왔다」.
    // 산출 0 이면 절 자체가 없다 (AC2 — 빈 자리·지어낸 예시 0). 표시는 읽기 전용이고 (AC4),
    // 노트 링크가 근거로 간다 (AC3) — 확정은 검토함 몫 그대로 ----
    if (view.completed && this.plugin.store !== null) {
      const registry = await loadRegistryFile(this.plugin.io, PLUGIN_VAULT_DIR);
      const highlights = firstIndexHighlights(this.plugin.store, registry);
      if (highlights.length > 0) {
        contentEl.createEl("h3", { text: "이게 네 노트에서 나왔다" });
        const label = { contradiction: "모순", gap: "공백", connection: "의외의 연결" } as const;
        for (const h of highlights) {
          const row = new Setting(contentEl).setName(label[h.kind]).setDesc(h.summary);
          for (const note of h.notes) {
            row.addButton((b) =>
              b.setButtonText(note).onClick(() => {
                void this.app.workspace.openLinkText(note, "", false);
                this.close();
              }),
            );
          }
        }
      }
    }
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}

// ---- S2 — 검토함 모달: 병합·타이핑·동사 제안의 수락·기각. 전부 사람의 호출 하나씩이다 (AC6) ----

class ReviewModal extends Modal {
  constructor(
    app: App,
    private readonly plugin: OntoFlowPlugin,
  ) {
    super(app);
  }

  override onOpen(): void {
    void this.render();
  }

  private act(work: () => Promise<void>): void {
    void (async () => {
      try {
        await work();
        await this.plugin.persistCanonical(); // 검토 행동은 정본을 움직인다 — PG 모드 반영 (#63)
      } catch (e) {
        new Notice(`검토 실패: ${(e as Error).message}`);
      }
      await this.render();
    })();
  }

  private async render(): Promise<void> {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "OntoFlow 검토함" });
    const store = this.plugin.store;
    if (store === null) {
      contentEl.createEl("p", { text: "정본이 아직 열리지 않았다." });
      return;
    }
    const io = this.plugin.io;
    const view = await reviewView(io, PLUGIN_VAULT_DIR);
    const registry = await loadRegistryFile(io, PLUGIN_VAULT_DIR);

    contentEl.createEl("h3", { text: `병합 제안 (${view.merges.length})` });
    for (const m of view.merges) {
      new Setting(contentEl)
        .setName(`「${m.name}」 → ${m.node}`)
        .setDesc(`확신 ${m.confidence}`)
        .addButton((b) =>
          b.setButtonText("수락").onClick(() =>
            this.act(() => acceptMergeAction(io, PLUGIN_VAULT_DIR, store, m.name, m.node)),
          ),
        )
        .addButton((b) =>
          b.setButtonText("기각").onClick(() =>
            this.act(() => rejectMergeAction(io, PLUGIN_VAULT_DIR, store, m.name, m.node)),
          ),
        );
    }

    contentEl.createEl("h3", { text: `타이핑 제안 (${view.typings.length})` });
    const verbChoices = registry.verbs.filter((v) => v.id !== FALLBACK_VERB_ID);
    for (const t of view.typings) {
      let picked = verbChoices[0]?.id ?? "";
      new Setting(contentEl)
        .setName(`${t.s} → ${t.o}`)
        .setDesc(`출처 ${t.note}`)
        .addDropdown((d) => {
          for (const v of verbChoices) d.addOption(v.id, `${v.label} (${v.id})`);
          d.setValue(picked).onChange((v) => {
            picked = v;
          });
        })
        .addButton((b) =>
          b.setButtonText("수락").onClick(() =>
            this.act(() =>
              acceptTypingAction(io, PLUGIN_VAULT_DIR, store, registry, t.s, t.o, t.note, picked),
            ),
          ),
        )
        .addButton((b) =>
          b.setButtonText("기각").onClick(() =>
            this.act(() => rejectTypingAction(io, PLUGIN_VAULT_DIR, t.s, t.o, t.note)),
          ),
        );
    }

    contentEl.createEl("h3", { text: `재부상 판정 대기 (${view.inferences.length})` });
    for (const inf of view.inferences) {
      const row = new Setting(contentEl).setName(inf.summary).setDesc(inf.kind === "contradiction" ? "모순 — 한쪽을 철회하거나 둘 다 유지한다" : "공백 — 확인하면 다시 묻지 않는다");
      if (inf.kind === "contradiction") {
        inf.edges.forEach((e, index) => {
          row.addButton((b) =>
            b.setButtonText(`「${e.s} ${e.v} ${e.o}」 철회`).onClick(() =>
              this.act(() => retractInferenceAction(io, PLUGIN_VAULT_DIR, store, registry, inf.fingerprint, index)),
            ),
          );
        });
      }
      row.addButton((b) =>
        b.setButtonText(inf.kind === "contradiction" ? "둘 다 유지" : "확인").onClick(() =>
          this.act(() => dismissInferenceAction(io, PLUGIN_VAULT_DIR, inf.fingerprint)),
        ),
      );
    }

    contentEl.createEl("h3", { text: `동사 제안 (${view.verbs.length})` });
    for (const p of view.verbs) {
      let id = "";
      let superclass: Superclass = p.recommendedSuperclass;
      new Setting(contentEl)
        .setName(`「${p.verbRaw}」`)
        .setDesc(`관측 ${p.observations.length}회 · 추천 상위분류 ${p.recommendedSuperclass}`)
        .addText((t) => t.setPlaceholder("동사 id (예: refers-to)").onChange((v) => (id = v.trim())))
        .addDropdown((d) => {
          for (const s of SUPERCLASSES) d.addOption(s, s);
          d.setValue(superclass).onChange((v) => (superclass = v as Superclass));
        })
        .addButton((b) =>
          b.setButtonText("확정").onClick(() =>
            this.act(async () => {
              await confirmVerbAction(io, PLUGIN_VAULT_DIR, p.verbRaw, {
                id,
                label: p.verbRaw,
                superclass,
              });
            }),
          ),
        )
        .addButton((b) =>
          b.setButtonText("기각").onClick(() => this.act(() => rejectVerbAction(io, PLUGIN_VAULT_DIR, p.verbRaw))),
        );
    }
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}

// ---- 설정 탭 — 허브 주소·토큰(AC5: 여기 설정 저장소가 토큰의 유일한 자리) · 그래프 홈 지정 (#31) ----

class OntoFlowSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly plugin: OntoFlowPlugin,
  ) {
    super(app, plugin);
  }

  override display(): void {
    const { containerEl } = this;
    containerEl.empty();

    // 네트워크 고지 (#105 AC7 · 개발자 정책) — 설정 화면이 「무엇이 어디로 가는가」를 먼저
    // 말한다. 최상위 제목(「설정」·플러그인 이름)은 세우지 않는다 — 가이드라인 UI 문구 규칙.
    containerEl.createEl("p", {
      text:
        "기본값은 외부 전송 0 이다 — 허브 주소·토큰을 넣고 민감정보 동의를 마칠 때까지 노트는 이 기기를 떠나지 않는다. " +
        "연결한 뒤에는 추출을 위해 노트 본문이 모아요 허브(보관 0 · zero-retention)로 간다. " +
        "BYO 엔드포인트를 설정하면 추출은 그 주소로만 가고 본문은 기기를 떠나지 않는다. 텔레메트리·사용 분석은 없다.",
    });

    new Setting(containerEl).setName("허브 주소").addText((t) =>
      t
        .setPlaceholder("https://…")
        .setValue(this.plugin.settings.hubBaseUrl)
        .onChange(async (v) => {
          this.plugin.settings.hubBaseUrl = v.trim();
          await this.plugin.saveSettings();
        }),
    );

    new Setting(containerEl)
      .setName("허브 토큰")
      .setDesc("토큰은 이 플러그인 설정 저장소에만 산다 — 로그·노트 본문에 실리지 않는다.")
      .addText((t) => {
        t.inputEl.type = "password";
        t.setValue(this.plugin.settings.hubToken ?? "").onChange(async (v) => {
          this.plugin.settings.hubToken = v.trim() === "" ? null : v.trim();
          await this.plugin.saveSettings();
        });
      });

    let homeInput = "";
    new Setting(containerEl)
      .setName("그래프 홈 지정")
      .setDesc("정본(.ontoflow)의 보관 자리 — vault 안 경로만 (모바일 어댑터는 vault 밖에 닿지 않는다).")
      .addText((t) => t.setPlaceholder("예: 90-시스템/ontoflow").onChange((v) => (homeInput = v.trim())))
      .addButton((b) =>
        b.setButtonText("이동").onClick(() =>
          void (async () => {
            try {
              const result = await designateHome(this.plugin.io, PLUGIN_VAULT_DIR, homeInput);
              this.plugin.store = await openVault(this.plugin.io, PLUGIN_VAULT_DIR);
              new Notice(`홈 이동 완료 — 옮긴 파일 ${result.moved.length}`);
            } catch (e) {
              new Notice(`홈 이동 실패: ${(e as Error).message}`);
            }
          })(),
        ),
      );

    // ---- 정본 자리 (#63) — sqlite(기본) 또는 사용자 소유 PG (금고의 postgres 자격증명 경유) ----
    new Setting(containerEl)
      .setName("정본 자리")
      .setDesc("sqlite = 그래프 홈 파일(기본) · pg = 사용자 소유 PostgreSQL — 허브 금고에 postgres 자격증명 등록이 선행이다. 전환 시 자동 이관은 없다(내보내기·가져오기 경유).")
      .addDropdown((d) => {
        d.addOption("sqlite", "SQLite (기본)");
        d.addOption("pg", "PostgreSQL (사용자 소유)");
        d.setValue(this.plugin.settings.canonical).onChange(async (v) => {
          this.plugin.settings.canonical = v === "pg" ? "pg" : "sqlite";
          await this.plugin.saveSettings();
          new Notice("정본 자리 변경 — 플러그인 재시작(비활성/활성) 시 적용된다");
        });
      });

    // ---- BYO 추출 (#88) — 주소·모델이 둘 다 서야 선다: 반쪽 설정은 기본 경로(모아요 서빙).
    // 자격증명은 이 설정 저장소에만 산다 — 허브 금고에 두지 않는다(기기를 떠나지 않는 것이 규율) ----
    new Setting(containerEl)
      .setName("BYO 추출 엔드포인트")
      .setDesc(
        "OpenAI 호환 주소(예: http://localhost:11434 — Ollama·vLLM·LM Studio). 모델명과 함께 설정하면 추출이 이 엔드포인트로만 간다 — 노트 본문이 기기를 떠나지 않는다. 품질 게이트 밖(비보증). 비우면 모아요 서빙(기본).",
      )
      .addText((t) =>
        t
          .setPlaceholder("http://localhost:11434")
          .setValue(this.plugin.settings.byoUrl)
          .onChange(async (v) => {
            this.plugin.settings.byoUrl = v.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("BYO 모델명")
      .setDesc("엔드포인트에 떠 있는 모델 이름 — 선택은 사용자 몫(품질 비보증).")
      .addText((t) =>
        t
          .setPlaceholder("예: gemma4:26b-a4b")
          .setValue(this.plugin.settings.byoModel)
          .onChange(async (v) => {
            this.plugin.settings.byoModel = v.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("BYO API 키 (선택)")
      .setDesc("로컬 엔드포인트는 보통 비워 둔다. 키는 이 설정 저장소에만 살고 BYO 호출 헤더로만 흐른다 — 허브에 실리지 않는다.")
      .addText((t) => {
        t.inputEl.type = "password";
        t.setValue(this.plugin.settings.byoApiKey ?? "").onChange(async (v) => {
          this.plugin.settings.byoApiKey = v.trim() === "" ? null : v.trim();
          await this.plugin.saveSettings();
        });
      });

    // ---- 외부 소스 연결 (#74) — OAuth 중개는 허브 콘솔에서 완결된다: 토큰은 플러그인을
    // 결코 지나지 않는다 (금고 직행). 여기 버튼은 그 한 화면을 여는 손잡이다 ----
    new Setting(containerEl)
      .setName("외부 소스 연결")
      .setDesc("OneNote·Google Drive·Dropbox 를 토큰 발급 없이 연결한다 — 허브 콘솔의 「연결」 버튼이 동의 화면으로 안내하고, 토큰은 금고로 직행한다(이 플러그인은 토큰을 보지 않는다).")
      .addButton((b) =>
        b.setButtonText("연결 관리 열기").onClick(() => {
          const base = this.plugin.settings.hubBaseUrl.trim().replace(/\/+$/, "");
          if (base === "") {
            new Notice("허브 주소를 먼저 설정한다");
            return;
          }
          window.open(`${base}/console`);
        }),
      );

    // ---- 수집 소스 목록 (#55) — 등록·해제가 수집의 분모다 (AC4): 해제하면 이후 변경은 수집 0 ----
    new Setting(containerEl)
      .setName("수집 소스")
      .setDesc("vault 밖 md 폴더(일반·Logseq·클라우드 동기화 폴더) — 읽기 전용 수집, 데스크톱 전용.")
      .setHeading();

    for (const s of this.plugin.settings.sources) {
      new Setting(containerEl)
        .setName(`${s.id} (${s.kind})`)
        .setDesc(s.root)
        .addButton((b) =>
          b.setButtonText("해제").onClick(() =>
            void (async () => {
              try {
                this.plugin.settings.sources = unregisterSource(this.plugin.settings.sources, s.id);
                await this.plugin.saveSettings();
                await removeSourceState(this.plugin.io, PLUGIN_VAULT_DIR, s.id); // 상태도 함께 걷는다
                new Notice(`소스 해제: ${s.id} — 이후 변경은 수집되지 않는다`);
                this.display();
              } catch (e) {
                new Notice(`소스 해제 실패: ${(e as Error).message}`);
              }
            })(),
          ),
        );
    }

    let srcId = "";
    let srcKind: SourceKind = "md";
    let srcRoot = "";
    new Setting(containerEl)
      .setName("소스 등록")
      .setDesc("id 는 소문자·숫자·하이픈. 경로는 폴더 절대 경로.")
      .addText((t) => t.setPlaceholder("id (예: logseq-main)").onChange((v) => (srcId = v.trim())))
      .addDropdown((d) => {
        for (const k of SOURCE_KINDS) {
          if (k === "bear" && !isMacDesktop()) continue; // macOS 밖 비노출 (AC4)
          d.addOption(k, k === "md" ? "md 폴더" : k === "logseq" ? "Logseq" : "Bear (macOS)");
        }
        d.setValue(srcKind).onChange((v) => (srcKind = v as SourceKind));
      })
      .addText((t) => t.setPlaceholder("/Users/…/폴더").onChange((v) => (srcRoot = v.trim())))
      .addButton((b) =>
        b.setButtonText("등록").onClick(() =>
          void (async () => {
            try {
              // Bear 는 경로 생략 = 고정 기본 자리 — 수집 시점에 홈을 붙여 푼다.
              const root = srcKind === "bear" && srcRoot === "" ? "(기본 자리)" : srcRoot;
              this.plugin.settings.sources = registerSource(this.plugin.settings.sources, {
                id: srcId,
                kind: srcKind,
                root,
              });
              await this.plugin.saveSettings();
              new Notice(`소스 등록: ${srcId}`);
              this.display();
            } catch (e) {
              new Notice(`소스 등록 실패: ${(e as Error).message}`);
            }
          })(),
        ),
      );

    // ---- 합성 자리 (#59) — 기계 소유물의 전용 폴더: 지정 이동은 기존 합성 노트를 함께 옮긴다 ----
    let synthDirInput = "";
    new Setting(containerEl)
      .setName("합성 자리 지정")
      .setDesc("정리 노트(기계 소유물)가 서는 폴더 — 기본 ontoflow-notes. 이동 시 기존 합성 노트도 옮긴다.")
      .addText((t) => t.setPlaceholder("예: 90-시스템/정리").onChange((v) => (synthDirInput = v.trim())))
      .addButton((b) =>
        b.setButtonText("이동").onClick(() =>
          void (async () => {
            try {
              const state = await loadSynthesisState(this.plugin.io, PLUGIN_VAULT_DIR);
              const moved = await designateSynthesisDir(this.plugin.io, PLUGIN_VAULT_DIR, state, synthDirInput);
              await saveSynthesisState(this.plugin.io, PLUGIN_VAULT_DIR, moved);
              new Notice(`합성 자리 이동 완료 — ${moved.dir} (노트 ${Object.keys(moved.notes).length})`);
            } catch (e) {
              new Notice(`합성 자리 이동 실패: ${(e as Error).message}`);
            }
          })(),
        ),
      );
  }
}
