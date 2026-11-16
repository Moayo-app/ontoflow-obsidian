// 옵시디언 진입점 — 조립만 한다: 수집(F1) 배선 · S1/S2 화면 · 커맨드 · 설정 (이슈 #42).
// 판단은 전부 코어와 뷰모델(screens·sync·commands)에 있다 — 이 파일은 옵시디언 API 와의 접착뿐이다.
import { Modal, Notice, Plugin, PluginSettingTab, Setting, TFile, getLanguage, type App } from "obsidian";
import {
  FALLBACK_VERB_ID,
  SOURCE_KINDS,
  SUPERCLASSES,
  chooseVault,
  collectApiSource,
  collectGitHubSources,
  collectRegisteredSources,
  isApiSourceKind,
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
  dumpCanonical,
  loadDictionary,
  loadOnboarding,
  markShared,
  openVault,
  retractShare,
  registerSource,
  removeSourceState,
  suggestVerbId,
  unregisterSource,
  type CollectedChange,
  type FileIo,
  computeNotionDelta,
  loadProjection,
  recordProjectionResult,
  type IngestSource,
  type SourceReader,
  type GraphStore,
  type SourceKind,
  type Superclass,
  type VaultReader,
} from "./core.js";
import { HubClientError, hubClient, type Extractor, type HubClient, type IngestSourcesInfo } from "./hub-client.js";
import { obsidianFetch } from "./net.js";

// 문구 한 벌 (ISSUE-368) — 로케일은 로드 시 한 번: 옵시디언 언어 변경은 재시작을 동반한다.
// getLanguage 는 @since 1.8.7 — minAppVersion(1.8.7) 플로어 안이다(도입 버전의 정본은 d.ts 의
// @since, 패치 버전까지 — 1.8.0 선언은 심사 Error 였다). typeof 가드는 바인딩을 안 드는
// 테스트 더블(모의 obsidian 모듈)의 방어다.
const P = pluginStrings(typeof getLanguage === "function" ? getLanguage() : "en");

// 확신 밴드 (ISSUE-372) — 경계는 추출 게이트의 관례(0.8 고확신)와 0.5 중간선이다.
const confidenceBand = (v: number): string => (v >= 0.8 ? P.confidenceHigh : v >= 0.5 ? P.confidenceMid : P.confidenceLow);
import { configureEmbeddedSqlJs } from "./sql-wasm.js";
import { PLUGIN_VAULT_DIR, obsidianFileIo } from "./obsidian-io.js";
import { bearDbPath, isMacDesktop, nodeBearFs, readBearDbBytes } from "./bear-io.js";
import { folderSourceReader, nodeFolderFs } from "./source-io.js";
import { loadRegistryFile } from "./registry-io.js";
import { fmt, pluginStrings } from "./strings.js";
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
  EVENT_QUIET_MS,
  drainPgInbox,
  runResurface,
  applyLocal,
  catchUp,
  collectEvents,
  extractorFor,
  flushPgCanonical,
  holdForLater,
  loadPgCanonical,
  nextFlushDelay,
  observedFromEvents,
  promoteProjectionEdits,
  runInitialIndex,
  runSynthesis,
  sendToHub,
  takeHeld,
  type ObservedNote,
  type VaultEvent,
} from "./sync.js";
import { EXPORT_FILES, exportCommand, projectNoteCommand, type ExportFormat } from "./commands.js";

export default class OntoFlowPlugin extends Plugin {
  settings: PluginSettings = DEFAULT_SETTINGS;
  io!: FileIo;
  store: GraphStore | null = null;
  /** PG 정본(#63)의 낙관적 잠금 카운터 — sqlite 모드에서는 쓰지 않는다. */
  canonicalRev = 0;
  /** 워크스페이스 투영(ISSUE-365)의 rev 가드 — null = 아직 적재 전. 워크스페이스 전환 시 리셋. */
  workspaceRev: number | null = null;
  // 이벤트 대기열 (#439 ①·②) — 디바운스 버퍼이자 store 준비 전 보류함: 수집 상태에 박는
  // 것은 플러시 때뿐이라, 플러시 전에 날아간 몫은 다음 시작 따라잡기가 되줍는다 (유실 0).
  private pendingEvents: VaultEvent[] = [];
  private flushTimer: number | null = null;
  private firstQueuedAt: number | null = null;
  private flushing = false;
  private deferNoticeShown = false;

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
      name: P.cmdOnboarding,
      callback: () => new OnboardingModal(this.app, this).open(),
    });
    this.addCommand({
      id: "open-review",
      name: P.cmdReview,
      callback: () => new ReviewModal(this.app, this).open(),
    });
    this.addCommand({
      id: "project-active-note",
      name: P.cmdSyncNote,
      callback: () => void this.projectActiveNote(),
    });
    this.addCommand({
      id: "export-jsonld",
      name: P.cmdExportJsonld,
      callback: () => void this.export("jsonld"),
    });
    this.addCommand({
      id: "export-graphml",
      name: P.cmdExportGraphml,
      callback: () => void this.export("graphml"),
    });
    this.addCommand({
      id: "retry-held",
      name: P.cmdRetryHeld,
      callback: () => void this.retryHeld(),
    });
    this.addCommand({
      id: "collect-sources",
      name: P.cmdImportSources,
      callback: () => void this.collectSources(true),
    });
    this.addCommand({
      id: "synthesize-sources",
      name: P.cmdSynthesize,
      callback: () => void this.synthesizeSources(this.settings.sources.map((s) => s.id), true),
    });
    this.addCommand({
      id: "sync-notion",
      name: P.cmdSyncNotion,
      callback: () => void this.syncProjection("notion"),
    });
    this.addCommand({
      id: "sync-postgres",
      name: P.cmdSyncPostgres,
      callback: () => void this.syncProjection("postgres"),
    });
    this.addCommand({
      id: "weekly-report",
      name: P.cmdWeeklyReport,
      callback: () => void this.resurfaceCycle(true),
    });
    this.addCommand({
      id: "share-active-note",
      name: P.cmdShareNote,
      callback: () => void this.setShare(true),
    });
    this.addCommand({
      id: "retract-share-active-note",
      name: P.cmdRetractShare,
      callback: () => void this.setShare(false),
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
            this.queueEvent({ kind: "delete", path: file.path });
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
    return hubClient(
      this.settings.hubBaseUrl,
      async () => this.settings.hubToken,
      obsidianFetch,
      () => this.settings.workspaceId,
    );
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
          if (written.length > 0) new Notice(fmt(P.inboxDrained, { n: written.length }));
        } catch (e) {
          new Notice(fmt(P.inboxDrainFailed, { msg: (e as Error).message }));
        }
      }
      // 따라잡기 (ISSUE-451) — observed(재독 원문)가 꺼진 동안의 블록 편집을 승격에 싣는다:
      // changes 만 넘기던 때는 블록만 고친 노트가 산출 0 으로 끝나 다음 재투영에 되덮였다.
      const { changes, observed } = await catchUp(this.io, PLUGIN_VAULT_DIR, this.reader());
      await this.processChanges(changes, observed);
    } catch (e) {
      this.store = this.settings.canonical === "pg" ? null : this.store; // 반쪽 연결 0
      new Notice(fmt(P.startFailed, { msg: (e as Error).message }));
    }
    // 시작 중 적체된 이벤트 (#439 ①) — store 가 섰으면 지금 비우고, 못 섰으면 대기 안내가 선다.
    await this.flushEvents();
    await this.collectSources(false);
  }

  // PG 정본 반영 (#63) — 변경을 일으킨 호출자가 끝에서 부른다. 409(rev 가드)는 다른 자리의
  // 반영이 먼저 선 것 — 임의 병합 없이 재적재를 안내한다 (AC5).
  async persistCanonical(): Promise<void> {
    if (this.store !== null && this.settings.canonical === "pg") {
      try {
        this.canonicalRev = await flushPgCanonical(this.io, PLUGIN_VAULT_DIR, this.hub(), this.store, this.canonicalRev);
      } catch (e) {
        new Notice(fmt(P.dbFlushFailed, { msg: (e as Error).message }));
      }
    }
    await this.projectToWorkspace();
  }

  // 워크스페이스 투영 (ISSUE-365) — 조직 PG 의 내 멤버 스키마에 그래프 사본을 되민다. 정본
  // 지위는 무변(가시성 ≠ 소유 — #53·#214): 합집합·전문가 찾기는 이 사본의 공유 표시만 읽는다.
  // rev 가드 409 는 다른 기기의 투영이 먼저 선 것 — 투영은 로컬 정본의 사본이라 재적재 뒤
  // 덮어쓰기가 곧 올바른 병합이다(충돌은 사용자 편집 항상 승).
  private async projectToWorkspace(): Promise<void> {
    if (this.settings.workspaceId === null || this.store === null) return;
    try {
      const hub = this.hub();
      const registry = await loadRegistryFile(this.io, PLUGIN_VAULT_DIR);
      if (this.workspaceRev === null) this.workspaceRev = (await hub.workspaceLoad()).rev;
      try {
        this.workspaceRev = (await hub.workspaceFlush(dumpCanonical(this.store, registry, this.workspaceRev))).rev;
      } catch (e) {
        if (!(e instanceof HubClientError) || e.status !== 409) throw e;
        this.workspaceRev = (await hub.workspaceLoad()).rev;
        this.workspaceRev = (await hub.workspaceFlush(dumpCanonical(this.store, registry, this.workspaceRev))).rev;
      }
    } catch (e) {
      this.workspaceRev = null; // 반쪽 상태 0 — 다음 투영이 rev 를 새로 적재한다
      new Notice(fmt(P.workspaceProjectionFailed, { msg: (e as Error).message }));
    }
  }

  // 공유 1비트 (ISSUE-365 — #62 표면) — 현재 노트를 워크스페이스 합집합에 올리거나 거둔다.
  // 표시는 로컬 정본(shares)에 살고, 워크스페이스가 보는 것은 투영된 공유 합집합뿐이다 (#53·#214).
  private async setShare(on: boolean): Promise<void> {
    const file = this.app.workspace.getActiveFile();
    if (!file || this.store === null) {
      new Notice(P.noNoteToShare);
      return;
    }
    if (this.settings.workspaceId === null) {
      new Notice(P.noWorkspaceSelected);
      return;
    }
    try {
      if (on) await markShared(this.store, "note", file.path, new Date().toISOString());
      else await retractShare(this.store, "note", file.path);
      await this.persistCanonical();
      new Notice(on ? fmt(P.shared, { path: file.path }) : fmt(P.unshared, { path: file.path }));
    } catch (e) {
      new Notice(fmt(P.shareFailed, { msg: (e as Error).message }));
    }
  }

  // 수집 소스 따라잡기 (#55 · ISSUE-364) — 소스는 vault 이벤트가 없어 언제나 스냅샷 대조다:
  // 시작 시 한 번 + 커맨드 수동. 파일 소스(설정 목록)와 API 소스(허브 금고의 연결) 둘 다 돈다.
  private async collectSources(verbose: boolean): Promise<void> {
    await this.collectFileSources(verbose);
    await this.collectApiSources(verbose);
  }

  // API 소스 수집 (ISSUE-364) — 분모는 허브 금고의 연결이다(설정 목록이 아니라): 콘솔의 「연결」
  // 버튼이 곧 등록이다 (#74 AC4 승계). known 증분 선별 → 허브 pull(버퍼 안 — 보관 0) → 같은
  // reconcile(디프·메아리 차단) → 같은 파이프라인. 워크스페이스 문맥이면 관리자가 연결한 조직
  // 소스를 당긴다 — 트리거는 멤버 세션이다(허브 타이머 비채택: 보관 0 · 상시 표면 +0).
  private async collectApiSources(verbose: boolean): Promise<void> {
    if (this.store === null) return;
    let info: IngestSourcesInfo;
    try {
      info = await this.hub().ingestSources();
    } catch (e) {
      // 허브 미연결(주소·키 없음)이면 API 소스도 없다 — 시작 사이클에서는 조용히 쉰다.
      if (verbose) new Notice(fmt(P.sourceListFailed, { msg: (e as Error).message }));
      return;
    }
    for (const kind of info.kinds.filter(isApiSourceKind)) {
      if (this.settings.sources.some((s) => s.id === kind)) {
        new Notice(fmt(P.sourceIdCollision, { id: kind }));
        continue;
      }
      try {
        let changes: CollectedChange[];
        if (kind === "github" && info.githubAnchors.length > 0) {
          // 복수 닻 (ISSUE-482) — 저장소 = 소스: 저장소별로 당기고 실패를 격리한다. 실패
          // 저장소는 그 소스의 reconcile 이 돌지 않아 삭제 오판이 없고, 안내가 저장소명을 짚는다.
          const r = await collectGitHubSources(
            this.io,
            PLUGIN_VAULT_DIR,
            info.githubAnchors,
            info.githubPrimary,
            (k, known, anchor) => this.hub().ingestPull(k, known, anchor),
          );
          for (const p of r.problems) new Notice(fmt(P.apiSourceFailed, { kind, msg: p }));
          changes = r.changes;
        } else {
          // 닻 목록이 비면(구 허브) 종전 단일 소스 길 그대로 — 조용한 0 수집으로 바꾸지 않는다.
          changes = await collectApiSource(this.io, PLUGIN_VAULT_DIR, kind, (k, known) =>
            this.hub().ingestPull(k, known),
          );
        }
        await this.processChanges(changes);
        if (verbose) new Notice(fmt(P.apiSourceCollected, { kind, n: changes.length }));
        const touched = [...new Set(changes.map((c) => c.note.split(":/")[0] ?? ""))].filter((s) => s !== "");
        await this.synthesizeSources(touched, false);
      } catch (e) {
        // 한 소스의 실패가 다른 소스를 멈추지 않는다 — 소스별 명시 안내.
        new Notice(fmt(P.apiSourceFailed, { kind, msg: (e as Error).message }));
      }
    }
  }

  private async collectFileSources(verbose: boolean): Promise<void> {
    if (this.settings.sources.length === 0 || this.store === null) {
      if (verbose) new Notice(P.noSources);
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
          new Notice(fmt(P.bearMacOnly, { id: s.id }));
          continue;
        }
        const bear = nodeBearFs();
        const path = s.root.trim() === "" || s.root === "(기본 자리)" ? bearDbPath(bear.homedir) : s.root;
        const bytes = await readBearDbBytes(bear.fs, path);
        if (bytes === null) {
          new Notice(fmt(P.bearMissing, { id: s.id, path }));
          continue;
        }
        const db = await openSqlDatabase(bytes);
        try {
          const notes = readBearNotes(db);
          if (notes.encryptedSkipped > 0) {
            new Notice(fmt(P.bearEncryptedSkipped, { n: notes.encryptedSkipped }));
          }
          readers.set(s.id, bearSourceReader(notes));
          collectable.push(s);
        } finally {
          db.close();
        }
      }
      const changes = await collectRegisteredSources(this.io, PLUGIN_VAULT_DIR, collectable, (s) => {
        const reader = readers.get(s.id);
        if (!reader) throw new Error(fmt(P.sourceReaderMissing, { id: s.id }));
        return reader;
      });
      await this.processChanges(changes);
      if (verbose) new Notice(fmt(P.sourcesCollected, { n: this.settings.sources.length, changes: changes.length }));
      // 수집 완료 → 소스 단위 합성 갱신 (#59 트리거) — 변경이 있던 소스만.
      const changedSources = [...new Set(changes.map((c) => c.note.split(":/")[0] ?? ""))].filter((s) => s !== "");
      await this.synthesizeSources(changedSources, false);
    } catch (e) {
      new Notice(fmt(P.collectFailed, { msg: (e as Error).message }));
    }
  }

  // 합성 갱신 (#59) — 소스 단위. 동의 전·그래프 없음은 runSynthesis 가 명시 오류로 세운다.
  // 동기화 집행 (ISSUE-372 — 출고 표면) — 델타는 로컬 정본에서 뜨고(computeNotionDelta 는
  // 두 목적지 공통 꼴), 판정은 허브가, 매핑 반영은 다시 로컬이 진다. 크레딧 비소비(내보내기).
  private async syncProjection(dest: "notion" | "postgres"): Promise<void> {
    if (this.store === null) return;
    try {
      const registry = await loadRegistryFile(this.io, PLUGIN_VAULT_DIR);
      const state = loadProjection(this.store, dest);
      const delta = computeNotionDelta(this.store, registry, state.mapping);
      const result = await this.hub().projectTo(dest, { registry, delta, mapping: state.mapping });
      await recordProjectionResult(
        this.store,
        dest,
        {
          newMappings: result.newMappings,
          syncedLocalIds: result.syncedLocalIds,
          removedLocalIds: result.removedLocalIds,
          failure: (result.failure ?? null) as Parameters<typeof recordProjectionResult>[2]["failure"],
        },
        new Date().toISOString(),
      );
      if (result.failure != null) {
        new Notice(fmt(P.projSyncInterrupted, { dest }));
      } else {
        new Notice(fmt(P.projSyncDone, { dest, n: delta.nodes.length + delta.edges.length, held: (result.held ?? []).length }));
      }
    } catch (e) {
      new Notice(fmt(P.projSyncFailed, { dest, msg: (e as Error).message }));
    }
  }

  private async synthesizeSources(sourceIds: readonly string[], verbose: boolean): Promise<void> {
    if (this.store === null || sourceIds.length === 0) {
      if (verbose) new Notice(P.nothingToSynthesize);
      return;
    }
    for (const sourceId of sourceIds) {
      try {
        const { path, title, md } = await runSynthesis(this.io, PLUGIN_VAULT_DIR, this.store, this.hub(), sourceId, new Date().toISOString());
        await this.persistCanonical(); // 합성은 그래프를 바꾸지 않지만 투영 상태가 움직일 수 있다
        if (verbose) new Notice(fmt(P.synthesized, { path }));
        // API 목적지 전송 (ISSUE-372 — 출고 표면): OneNote·Evernote 소스의 정리 노트는 그 자리로도
        // 보낸다. API 소스의 id 는 종류 그대로다(ISSUE-364 — collectApiSource 가 kind 를 id 로 쓴다).
        // 쓰기 자격증명이 없으면 허브가 404 로 세우고(#56 AC6), 그 건너뜀이 합성을 막지 않는다.
        if (sourceId === "onenote" || sourceId === "evernote") {
          const kind = sourceId;
          try {
            await this.hub().synthesizeTo(kind, title, md);
            if (verbose) new Notice(fmt(P.synthDelivered, { dest: kind }));
          } catch (deliverErr) {
            if (verbose) new Notice(fmt(P.synthDeliverSkipped, { dest: kind, msg: (deliverErr as Error).message }));
          }
        }
      } catch (e) {
        new Notice(fmt(P.synthesizeFailed, { id: sourceId, msg: (e as Error).message }));
      }
    }
  }

  private async onWrite(file: TFile): Promise<void> {
    const content = await this.app.vault.cachedRead(file);
    this.queueEvent({
      kind: "write",
      path: file.path,
      content,
      stat: { mtime: file.stat.mtime, size: file.stat.size },
    });
  }

  private async onRename(file: TFile, oldPath: string): Promise<void> {
    const content = await this.app.vault.cachedRead(file);
    this.queueEvent({
      kind: "rename",
      from: oldPath,
      to: file.path,
      content,
      stat: { mtime: file.stat.mtime, size: file.stat.size },
    });
  }

  // 디바운스 적재 (#439 ②) — 이벤트마다 전체 파이프라인(수집 직렬화·전량 덤프·허브 왕복)을
  // 돌리지 않는다: 조용 창까지 모아 한 묶음으로 민다. 지연 판정은 코어(nextFlushDelay) 몫.
  private queueEvent(event: VaultEvent): void {
    if (this.pendingEvents.length === 0) this.firstQueuedAt = Date.now();
    this.pendingEvents.push(event);
    if (this.flushTimer !== null) window.clearTimeout(this.flushTimer);
    this.flushTimer = window.setTimeout(
      () => void this.flushEvents(),
      nextFlushDelay(this.firstQueuedAt ?? Date.now(), Date.now()),
    );
  }

  private async flushEvents(): Promise<void> {
    if (this.flushTimer !== null) {
      window.clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.pendingEvents.length === 0) return;
    if (this.flushing) {
      // 플러시 중 재진입 — 끝난 뒤 조용 창으로 다시 잡는다 (이벤트 유실 0).
      this.flushTimer = window.setTimeout(() => void this.flushEvents(), EVENT_QUIET_MS);
      return;
    }
    if (this.store === null) {
      // 수집 유실 0 (#439 ①) — 상태에 박기 전 대기: 전에는 collectEvent 가 상태를 먼저
      // 저장해, PG 적재 실패·시작 미완 중의 편집이 「이미 본 것」으로 박힌 채 조용히
      // 버려졌다(재시작 reconcile 에도 안 잡히는 영구 누락). 안내는 세션당 한 번.
      if (!this.deferNoticeShown) {
        this.deferNoticeShown = true;
        new Notice(P.eventsDeferred);
      }
      return;
    }
    const events = this.pendingEvents.splice(0);
    this.firstQueuedAt = null;
    this.flushing = true;
    try {
      const changes = await collectEvents(this.io, PLUGIN_VAULT_DIR, events);
      await this.processChanges(changes, observedFromEvents(events));
    } catch (e) {
      new Notice(fmt(P.collectFailed, { msg: (e as Error).message }));
    } finally {
      this.flushing = false;
    }
  }

  override onunload(): void {
    // 플러시 전 대기분은 수집 상태 미기록이다 — 다음 시작의 따라잡기가 되줍는다 (#439 ① 유실 0).
    if (this.flushTimer !== null) window.clearTimeout(this.flushTimer);
  }

  private async processChanges(
    changes: CollectedChange[],
    observed?: readonly ObservedNote[],
  ): Promise<void> {
    if (this.store === null) return;
    const onboarding = await loadOnboarding(this.io, PLUGIN_VAULT_DIR);
    // `§23` 동의 전 — 추출도 보류 적재도 없다 (AC2). 동의 뒤의 최초 색인이 전량을 따라잡는다.
    if (onboarding.consent === null) return;
    const registry = await loadRegistryFile(this.io, PLUGIN_VAULT_DIR);
    // 투영 편집 승격 (ISSUE-430 라이브 · ISSUE-451 따라잡기) — 수집 산출과 독립으로 관찰
    // 원문에서: 블록만 고친 저장은 수집 산출이 0(본문 무변)이라, 산출에 매달면 바로 그
    // 저장이 소리 없이 소실된다. 라이브는 이벤트 원문 1건, 따라잡기는 재독 원문 목록이다.
    let promoted = false;
    for (const o of observed ?? []) {
      if ((await promoteProjectionEdits(this.store, registry, o.path, o.content)) !== null) promoted = true;
    }
    if (changes.length === 0 && !promoted) return;
    if (changes.length > 0) {
      await applyLocal(this.io, PLUGIN_VAULT_DIR, this.store, registry, changes);
      try {
        const dispatch = await sendToHub(this.io, PLUGIN_VAULT_DIR, this.store, registry, this.extractor(), changes);
        this.surfaceBillingNotices(dispatch.notices); // 80/100% 거래 고지 — 「API 응답」 채널 (ISSUE-362)
      } catch (e) {
        // 허브가 안 닿거나 지갑이 닫혔다 — 추출 몫만 쌓인다 (#12 AC5). 로컬 효과는 이미 섰다.
        await holdForLater(this.io, PLUGIN_VAULT_DIR, changes);
        this.surfaceHold(e, changes.length); // 무언 보류 금지 (ISSUE-362) — 사유가 함께 선다
      }
    }
    await this.persistCanonical(); // PG 정본 (#63) — 변경 반영 (승격만 있어도 민다)
    await this.resurfaceCycle(false); // 재부상 (#80) — 주기가 지났을 때만 돈다 (편승, 크론 0)
  }

  // 보류 표면화 (ISSUE-362) — 402(지갑)는 서버 사유 그대로, 그 밖(오프라인 등)은 짧은 안내.
  // 전에는 catch 가 무언이라 「썼는데 그래프가 안 자란다」가 침묵 속에서 일어났다.
  private surfaceHold(e: unknown, count: number): void {
    const held = fmt(P.heldTail, { n: count });
    if (e instanceof HubClientError && e.status === 402) {
      new Notice(`${e.problems[0] ?? P.walletClosedFallback}\n${held}`, 10000);
      return;
    }
    new Notice(fmt(P.hubUnreachableHeld, { held }));
  }

  // 거래 고지 (ISSUE-362 — #193 AC12): 서버가 응답에 실은 80/100% 임계를 Notice 로 세운다.
  // 「발송 1회」 보장은 서버 장부(UsageRecord.notices) 몫이라 여기는 받은 것을 그대로 세울 뿐이다.
  private surfaceBillingNotices(kinds: readonly string[]): void {
    for (const kind of kinds) {
      if (kind === "usage-80") {
        new Notice(P.usage80, 10000);
      } else if (kind === "usage-100") {
        new Notice(P.usage100, 10000);
      }
    }
  }

  // 재부상 한 판 (#80) — 판정·큐 적재·리포트. 실패는 수집을 막지 않는다 (알림만).
  private async resurfaceCycle(force: boolean): Promise<void> {
    if (this.store === null) return;
    try {
      const registry = await loadRegistryFile(this.io, PLUGIN_VAULT_DIR);
      const outcome = await runResurface(this.io, PLUGIN_VAULT_DIR, this.store, registry, new Date().toISOString(), force);
      if (outcome === null) {
        if (force) new Notice(P.insightNotDue);
        return;
      }
      if (outcome.reportPath !== null) {
        new Notice(fmt(P.weeklyReportReady, { path: outcome.reportPath }) + (outcome.queued > 0 ? fmt(P.insightPendingSuffix, { n: outcome.queued }) : ""));
      } else if (force) {
        new Notice(P.nothingToSay);
      }
    } catch (e) {
      new Notice(fmt(P.insightFailed, { msg: (e as Error).message }));
    }
  }

  private async retryHeld(): Promise<void> {
    if (this.store === null) return;
    const items = await takeHeld(this.io, PLUGIN_VAULT_DIR);
    if (items.length === 0) {
      new Notice(P.noHeld);
      return;
    }
    const registry = await loadRegistryFile(this.io, PLUGIN_VAULT_DIR);
    try {
      const r = await sendToHub(this.io, PLUGIN_VAULT_DIR, this.store, registry, this.extractor(), items);
      await this.persistCanonical();
      this.surfaceBillingNotices(r.notices);
      new Notice(fmt(P.heldProcessed, { n: items.length, added: r.patch.added }));
    } catch (e) {
      await holdForLater(this.io, PLUGIN_VAULT_DIR, items); // 실패분은 되돌린다
      this.surfaceHold(e, items.length); // 재시도 실패도 같은 표면 — 402 는 사유가 선다 (ISSUE-362)
    }
  }

  private async projectActiveNote(): Promise<void> {
    const file = this.app.workspace.getActiveFile();
    if (!file || this.store === null) {
      new Notice(P.noNoteToSync);
      return;
    }
    try {
      const { changed } = await projectNoteCommand(this.io, PLUGIN_VAULT_DIR, this.store, file.path);
      new Notice(changed ? fmt(P.syncedNote, { path: file.path }) : P.syncUnchanged);
    } catch (e) {
      new Notice(fmt(P.syncFailed, { msg: (e as Error).message }));
    }
  }

  private async export(format: ExportFormat): Promise<void> {
    if (this.store === null) {
      new Notice(P.dbNotOpen);
      return;
    }
    try {
      const registry = await loadRegistryFile(this.io, PLUGIN_VAULT_DIR);
      await exportCommand(this.io, PLUGIN_VAULT_DIR, this.store, registry, format);
      new Notice(fmt(P.exported, { file: EXPORT_FILES[format] }));
    } catch (e) {
      new Notice(fmt(P.exportFailed, { msg: (e as Error).message }));
    }
  }
}

// ---- S1 — 온보딩 모달: 허브 연결 → vault 선택 → `§23` 동의 → 최초 색인 (동의 전 시작 비활성, AC2) ----

// 허브 주소 미설정 상태(첫 설치)의 콘솔 딥링크 목적지 — 설정이 서면 그 주소가 이긴다 (#441).
const HUB_CONSOLE_FALLBACK = "https://hub.ontoflow.app";

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
    contentEl.createEl("h2", { text: P.onboardingTitle });
    const view = onboardingView(await loadOnboarding(this.plugin.io, PLUGIN_VAULT_DIR));

    new Setting(contentEl)
      .setName(fmt(P.stepHubConnect, { state: view.hubConnected ? "✓" : P.notYetSuffix }))
      .setDesc(P.stepHubConnectDesc)
      // 딥링크 둘 (#441) — 「설정 탭에서 넣어 주세요」가 길 없는 안내였다: 설정이 비면
      // 연결 확인 버튼은 비활성인데, 그 설정으로 가는 손잡이가 모달 안에 없었다.
      .addButton((b) =>
        b.setButtonText(P.openHubConsoleBtn).onClick(() => {
          // API 키가 발급되는 자리 — 주소 설정 전이니 공개 콘솔이 폴백이다.
          const base = this.plugin.settings.hubBaseUrl.trim().replace(/\/+$/, "");
          window.open(`${base === "" ? HUB_CONSOLE_FALLBACK : base}/console`, "_blank");
        }),
      )
      .addButton((b) =>
        b.setButtonText(P.openSettingsBtn).onClick(() => {
          // 설정 패널은 공개 타입에 없다(커뮤니티 플러그인 통용 우회) — 탭 id = manifest id.
          const setting = (this.app as unknown as { setting: { open(): void; openTabById(id: string): void } }).setting;
          setting.open();
          setting.openTabById("ontoflow");
        }),
      )
      .addButton((b) =>
        b
          .setButtonText(P.checkConnectionBtn)
          .setDisabled(
            view.hubConnected ||
              this.plugin.settings.hubBaseUrl === "" ||
              this.plugin.settings.hubToken === null,
          )
          .onClick(async () => {
            // 인증 핑 (ISSUE-372) — 자격이 실제로 서야 ✓ 로 전이한다. 전에는 무검증 전이라
            // 틀린 주소·만료 토큰도 「연결됨」으로 섰다.
            try {
              await this.plugin.hub().ping();
            } catch (e) {
              new Notice(fmt(P.connectionCheckFailed, { msg: (e as Error).message }));
              return;
            }
            await updateOnboarding(this.plugin.io, PLUGIN_VAULT_DIR, connectHub);
            await this.render();
          }),
      );

    new Setting(contentEl).setName(fmt(P.stepChooseVault, { state: view.vaultChosen ? "✓" : P.notYetSuffix })).addButton((b) =>
      b
        .setButtonText(P.useThisVaultBtn)
        .setDisabled(view.vaultChosen)
        .onClick(async () => {
          await updateOnboarding(this.plugin.io, PLUGIN_VAULT_DIR, chooseVault);
          await this.render();
        }),
    );

    contentEl.createEl("p", { text: view.consentText });
    new Setting(contentEl).setName(fmt(P.stepConsent, { state: view.consentGranted ? "✓" : P.notYetSuffix })).addButton((b) =>
      b
        .setButtonText(P.consentBtn)
        .setDisabled(view.consentGranted)
        .onClick(async () => {
          await updateOnboarding(this.plugin.io, PLUGIN_VAULT_DIR, (s) =>
            grantConsent(s, new Date().toISOString()),
          );
          await this.render();
        }),
    );

    new Setting(contentEl)
      .setName(fmt(P.stepInitialIndex, { progress: view.progress, done: view.completed ? P.doneSuffix : "" }))
      .addButton((b) =>
        b
          .setButtonText(P.startIndexBtn)
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
                fmt(P.initialIndexDone, { n: result.total }) +
                  (result.held.length > 0 ? fmt(P.initialIndexHeldSuffix, { n: result.held.length }) : ""),
              );
            } catch (e) {
              new Notice(fmt(P.indexFailed, { msg: (e as Error).message }));
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
        contentEl.createEl("h3", { text: P.highlightsHeading });
        const label = { contradiction: P.highlightContradiction, gap: P.highlightGap, connection: P.highlightConnection } as const;
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
        new Notice(fmt(P.reviewFailed, { msg: (e as Error).message }));
      }
      await this.render();
    })();
  }

  private async render(): Promise<void> {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: P.reviewTitle });
    const store = this.plugin.store;
    if (store === null) {
      contentEl.createEl("p", { text: P.dbNotOpen });
      return;
    }
    const io = this.plugin.io;
    const view = await reviewView(io, PLUGIN_VAULT_DIR);
    const registry = await loadRegistryFile(io, PLUGIN_VAULT_DIR);

    contentEl.createEl("h3", { text: fmt(P.mergeHeading, { n: view.merges.length }) });
    for (const m of view.merges) {
      new Setting(contentEl)
        .setName(`「${m.name}」 → ${m.node}`)
        .setDesc(fmt(P.confidencePrefix, { band: confidenceBand(m.confidence), v: m.confidence }))
        .addButton((b) =>
          b.setButtonText(P.acceptBtn).onClick(() =>
            this.act(() => acceptMergeAction(io, PLUGIN_VAULT_DIR, store, m.name, m.node)),
          ),
        )
        .addButton((b) =>
          b.setButtonText(P.rejectBtn).onClick(() =>
            this.act(() => rejectMergeAction(io, PLUGIN_VAULT_DIR, store, m.name, m.node)),
          ),
        );
    }

    contentEl.createEl("h3", { text: fmt(P.typingHeading, { n: view.typings.length }) });
    const verbChoices = registry.verbs.filter((v) => v.id !== FALLBACK_VERB_ID);
    for (const t of view.typings) {
      let picked = verbChoices[0]?.id ?? "";
      new Setting(contentEl)
        .setName(`${t.s} → ${t.o}`)
        .setDesc(fmt(P.sourceNotePrefix, { note: t.note }))
        .addDropdown((d) => {
          for (const v of verbChoices) d.addOption(v.id, `${v.label} (${v.id})`);
          d.setValue(picked).onChange((v) => {
            picked = v;
          });
        })
        .addButton((b) =>
          b.setButtonText(P.acceptBtn).onClick(() =>
            this.act(() =>
              acceptTypingAction(io, PLUGIN_VAULT_DIR, store, registry, t.s, t.o, t.note, picked),
            ),
          ),
        )
        .addButton((b) =>
          b.setButtonText(P.rejectBtn).onClick(() =>
            this.act(() => rejectTypingAction(io, PLUGIN_VAULT_DIR, t.s, t.o, t.note)),
          ),
        );
    }

    contentEl.createEl("h3", { text: fmt(P.insightQueueHeading, { n: view.inferences.length }) });
    for (const inf of view.inferences) {
      const row = new Setting(contentEl).setName(inf.summary).setDesc(inf.kind === "contradiction" ? P.contradictionDesc : P.gapDesc);
      if (inf.kind === "contradiction") {
        inf.edges.forEach((e, index) => {
          row.addButton((b) =>
            b.setButtonText(fmt(P.retractEdgeBtn, { edge: `${e.s} ${e.v} ${e.o}` })).onClick(() =>
              this.act(() => retractInferenceAction(io, PLUGIN_VAULT_DIR, store, registry, inf.fingerprint, index)),
            ),
          );
        });
      }
      row.addButton((b) =>
        b.setButtonText(inf.kind === "contradiction" ? P.keepBothBtn : P.acceptBtn).onClick(() =>
          this.act(() => dismissInferenceAction(io, PLUGIN_VAULT_DIR, inf.fingerprint)),
        ),
      );
    }

    contentEl.createEl("h3", { text: fmt(P.verbHeading, { n: view.verbs.length }) });
    for (const p of view.verbs) {
      // 라벨→kebab 자동 제안 (ISSUE-360) — id 는 kebab 식별자 꼴만 등록부를 지난다(원문은 label).
      // 한글 원문처럼 제안이 비면 placeholder 가 꼴을 보여 준다 — 확정 시 코어가 명시 거부한다.
      let id = suggestVerbId(p.verbRaw);
      let superclass: Superclass = p.recommendedSuperclass;
      new Setting(contentEl)
        .setName(`「${p.verbRaw}」`)
        .setDesc(fmt(P.verbObservedDesc, { n: p.observations.length, superclass: p.recommendedSuperclass }))
        .addText((t) => t.setPlaceholder(P.verbIdPlaceholder).setValue(id).onChange((v) => (id = v.trim())))
        .addDropdown((d) => {
          for (const s of SUPERCLASSES) d.addOption(s, s);
          d.setValue(superclass).onChange((v) => (superclass = v as Superclass));
        })
        .addButton((b) =>
          b.setButtonText(P.confirmBtn).onClick(() =>
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
          b.setButtonText(P.rejectBtn).onClick(() => this.act(() => rejectVerbAction(io, PLUGIN_VAULT_DIR, p.verbRaw))),
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
    containerEl.createEl("p", { text: P.settingsNetworkNote });

    new Setting(containerEl).setName(P.hubUrlName).addText((t) =>
      t
        .setPlaceholder("https://…")
        .setValue(this.plugin.settings.hubBaseUrl)
        .onChange(async (v) => {
          this.plugin.settings.hubBaseUrl = v.trim();
          await this.plugin.saveSettings();
        }),
    );

    new Setting(containerEl)
      .setName(P.hubKeyName)
      .setDesc(P.hubKeyDesc)
      .addText((t) => {
        t.inputEl.type = "password";
        t.setPlaceholder("ofk_…");
        t.setValue(this.plugin.settings.hubToken ?? "").onChange(async (v) => {
          this.plugin.settings.hubToken = v.trim() === "" ? null : v.trim();
          await this.plugin.saveSettings();
        });
      });

    let homeInput = "";
    new Setting(containerEl)
      .setName(P.graphHomeName)
      .setDesc(P.graphHomeDesc)
      .addText((t) => t.setPlaceholder(P.graphHomePlaceholder).onChange((v) => (homeInput = v.trim())))
      .addButton((b) =>
        b.setButtonText(P.moveBtn).onClick(() =>
          void (async () => {
            try {
              const result = await designateHome(this.plugin.io, PLUGIN_VAULT_DIR, homeInput);
              this.plugin.store = await openVault(this.plugin.io, PLUGIN_VAULT_DIR);
              new Notice(fmt(P.homeMoved, { n: result.moved.length }));
            } catch (e) {
              new Notice(fmt(P.homeMoveFailed, { msg: (e as Error).message }));
            }
          })(),
        ),
      );

    // ---- 정본 자리 (#63) — sqlite(기본) 또는 사용자 소유 PG (금고의 postgres 자격증명 경유) ----
    new Setting(containerEl)
      .setName(P.dbPlaceName)
      .setDesc(P.dbPlaceDesc)
      .addDropdown((d) => {
        d.addOption("sqlite", P.dbSqliteOption);
        d.addOption("pg", P.dbPgOption);
        d.setValue(this.plugin.settings.canonical).onChange(async (v) => {
          this.plugin.settings.canonical = v === "pg" ? "pg" : "sqlite";
          await this.plugin.saveSettings();
          new Notice(P.dbPlaceChanged);
        });
      });

    // ---- 워크스페이스 문맥 (ISSUE-365) — 멤버로 일할 조직. 비우면 개인: 과금은 개인 지갑,
    // 투영(공유 합집합·전문가 찾기의 재료)은 돌지 않는다. 정본 지위는 어느 쪽이든 무변이다 ----
    new Setting(containerEl)
      .setName(P.workspaceName)
      .setDesc(P.workspaceDesc)
      .addText((t) =>
        t
          .setPlaceholder("org-…")
          .setValue(this.plugin.settings.workspaceId ?? "")
          .onChange(async (v) => {
            this.plugin.settings.workspaceId = v.trim() === "" ? null : v.trim();
            this.plugin.workspaceRev = null; // 전환 — 다음 투영이 새 스키마의 rev 를 적재한다
            await this.plugin.saveSettings();
          }),
      )
      .addButton((b) =>
        b.setButtonText(P.myWorkspacesBtn).onClick(() =>
          void (async () => {
            try {
              const orgs = await this.plugin.hub().listWorkspaces();
              if (orgs.length === 0) {
                new Notice(P.noWorkspaces);
                return;
              }
              new Notice(orgs.map((o) => `${o.name} (${o.role}) — ${o.orgId}`).join("\n"), 15000);
            } catch (e) {
              new Notice(fmt(P.workspaceListFailed, { msg: (e as Error).message }));
            }
          })(),
        ),
      );

    // ---- BYO 추출 (#88) — 주소·모델이 둘 다 서야 선다: 반쪽 설정은 기본 경로(모아요 서빙).
    // 자격증명은 이 설정 저장소에만 산다 — 허브 금고에 두지 않는다(기기를 떠나지 않는 것이 규율) ----
    new Setting(containerEl)
      .setName(P.byoUrlName)
      .setDesc(P.byoUrlDesc)
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
      .setName(P.byoModelName)
      .setDesc(P.byoModelDesc)
      .addText((t) =>
        t
          .setPlaceholder("gemma4:26b-a4b")
          .setValue(this.plugin.settings.byoModel)
          .onChange(async (v) => {
            this.plugin.settings.byoModel = v.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName(P.byoKeyName)
      .setDesc(P.byoKeyDesc)
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
      .setName(P.externalSourcesName)
      .setDesc(P.externalSourcesDesc)
      .addButton((b) =>
        b.setButtonText(P.openConsoleBtn).onClick(() => {
          const base = this.plugin.settings.hubBaseUrl.trim().replace(/\/+$/, "");
          if (base === "") {
            new Notice(P.hubUrlFirst);
            return;
          }
          window.open(`${base}/console`);
        }),
      );

    // ---- 수집 소스 목록 (#55) — 등록·해제가 수집의 분모다 (AC4): 해제하면 이후 변경은 수집 0 ----
    new Setting(containerEl)
      .setName(P.sourcesHeading)
      .setDesc(P.sourcesHeadingDesc)
      .setHeading();

    for (const s of this.plugin.settings.sources) {
      new Setting(containerEl)
        .setName(`${s.id} (${s.kind})`)
        .setDesc(s.root)
        .addButton((b) =>
          b.setButtonText(P.unregisterBtn).onClick(() =>
            void (async () => {
              try {
                this.plugin.settings.sources = unregisterSource(this.plugin.settings.sources, s.id);
                await this.plugin.saveSettings();
                await removeSourceState(this.plugin.io, PLUGIN_VAULT_DIR, s.id); // 상태도 함께 걷는다
                new Notice(fmt(P.sourceUnregistered, { id: s.id }));
                this.display();
              } catch (e) {
                new Notice(fmt(P.sourceUnregisterFailed, { msg: (e as Error).message }));
              }
            })(),
          ),
        );
    }

    let srcId = "";
    let srcKind: SourceKind = "md";
    let srcRoot = "";
    new Setting(containerEl)
      .setName(P.registerSourceName)
      .setDesc(P.registerSourceDesc)
      .addText((t) => t.setPlaceholder(P.sourceIdPlaceholder).onChange((v) => (srcId = v.trim())))
      .addDropdown((d) => {
        for (const k of SOURCE_KINDS) {
          if (k === "bear" && !isMacDesktop()) continue; // macOS 밖 비노출 (AC4)
          d.addOption(k, k === "md" ? P.sourceKindMd : k === "logseq" ? P.sourceKindLogseq : P.sourceKindBear);
        }
        d.setValue(srcKind).onChange((v) => (srcKind = v as SourceKind));
      })
      .addText((t) => t.setPlaceholder(P.sourceRootPlaceholder).onChange((v) => (srcRoot = v.trim())))
      .addButton((b) =>
        b.setButtonText(P.registerBtn).onClick(() =>
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
              new Notice(fmt(P.sourceRegistered, { id: srcId }));
              this.display();
            } catch (e) {
              new Notice(fmt(P.sourceRegisterFailed, { msg: (e as Error).message }));
            }
          })(),
        ),
      );

    // ---- 합성 자리 (#59) — 기계 소유물의 전용 폴더: 지정 이동은 기존 합성 노트를 함께 옮긴다 ----
    let synthDirInput = "";
    new Setting(containerEl)
      .setName(P.synthesisDirName)
      .setDesc(P.synthesisDirDesc)
      .addText((t) => t.setPlaceholder(P.synthesisDirPlaceholder).onChange((v) => (synthDirInput = v.trim())))
      .addButton((b) =>
        b.setButtonText(P.moveBtn).onClick(() =>
          void (async () => {
            try {
              const state = await loadSynthesisState(this.plugin.io, PLUGIN_VAULT_DIR);
              const moved = await designateSynthesisDir(this.plugin.io, PLUGIN_VAULT_DIR, state, synthDirInput);
              await saveSynthesisState(this.plugin.io, PLUGIN_VAULT_DIR, moved);
              new Notice(fmt(P.synthesisDirMoved, { dir: moved.dir, n: Object.keys(moved.notes).length }));
            } catch (e) {
              new Notice(fmt(P.synthesisDirMoveFailed, { msg: (e as Error).message }));
            }
          })(),
        ),
      );
  }
}
