// 플러그인 문구 카탈로그 (ISSUE-368) — 콘솔 console-strings 패턴의 플러그인 판: ko·en 두 벌이
// 같은 키를 지니고, 로케일은 옵시디언의 언어 설정(localStorage "language" — null = 영어)에서
// 한 번 읽는다. 어휘는 GLOSSARY 통일어(#199 — 동기화·가져오기·데이터베이스·수신함·인사이트),
// 말씨는 존댓말(#346 전례 — 정보량·의미 무변)이다. 마켓 퍼널의 입구가 영어라 기본값은 en 이다.
//
// 보간은 콘솔과 같은 {토큰} 치환이다 — 템플릿 리터럴을 카탈로그에 두면 두 벌이 코드가 된다.

export type PluginLocale = "ko" | "en";

export function detectLocale(): PluginLocale {
  try {
    // 옵시디언은 UI 언어를 localStorage "language" 에 둔다 — null·부재 = 영어.
    return (globalThis as { localStorage?: { getItem(k: string): string | null } }).localStorage?.getItem(
      "language",
    ) === "ko"
      ? "ko"
      : "en";
  } catch {
    return "en"; // 저장소가 닫힌 환경(테스트·연기 시험) — 기본 en
  }
}

export function fmt(text: string, values: Record<string, string | number>): string {
  let out = text;
  for (const [k, v] of Object.entries(values)) out = out.replace(`{${k}}`, String(v));
  return out;
}

export interface PluginStrings {
  // 커맨드 이름 — id 는 불변(연기 시험 접두 검사 축), 이름만 로케일을 탄다.
  cmdOnboarding: string;
  cmdReview: string;
  cmdSyncNote: string;
  cmdExportJsonld: string;
  cmdExportGraphml: string;
  cmdRetryHeld: string;
  cmdImportSources: string;
  cmdSynthesize: string;
  /** 동기화 집행 커맨드 둘 (ISSUE-372 — 출고 표면): 라우트만 있던 Notion·PostgreSQL 투영의 입구. */
  cmdSyncNotion: string;
  cmdSyncPostgres: string;
  projSyncDone: string;
  projSyncInterrupted: string;
  projSyncFailed: string;
  synthDelivered: string;
  synthDeliverSkipped: string;
  cmdWeeklyReport: string;
  cmdShareNote: string;
  cmdRetractShare: string;
  // 시작·수집(가져오기) 사이클
  startFailed: string;
  collectFailed: string;
  /** 수집 유실 0 (#439 ①) — store 준비 전 편집의 대기 안내: 세션당 한 번만 선다. */
  eventsDeferred: string;
  inboxDrained: string;
  inboxDrainFailed: string;
  dbFlushFailed: string;
  workspaceProjectionFailed: string;
  // 보류·거래 고지 (ISSUE-362)
  heldTail: string;
  walletClosedFallback: string;
  hubUnreachableHeld: string;
  usage80: string;
  usage100: string;
  noHeld: string;
  heldProcessed: string;
  // 가져오기 소스 (#55 · ISSUE-364)
  noSources: string;
  bearMacOnly: string;
  bearMissing: string;
  bearEncryptedSkipped: string;
  sourcesCollected: string;
  sourceReaderMissing: string;
  sourceListFailed: string;
  sourceIdCollision: string;
  apiSourceCollected: string;
  apiSourceFailed: string;
  // 합성 (#59)
  nothingToSynthesize: string;
  synthesized: string;
  synthesizeFailed: string;
  // 인사이트(재부상 #80)·리포트
  insightNotDue: string;
  weeklyReportReady: string;
  insightPendingSuffix: string;
  nothingToSay: string;
  insightFailed: string;
  // 동기화(투영)·내보내기
  noNoteToSync: string;
  syncedNote: string;
  syncUnchanged: string;
  syncFailed: string;
  dbNotOpen: string;
  exported: string;
  exportFailed: string;
  // 공유 (ISSUE-365)
  noNoteToShare: string;
  noWorkspaceSelected: string;
  shared: string;
  unshared: string;
  shareFailed: string;
  // 검토 (S2)
  reviewTitle: string;
  reviewFailed: string;
  mergeHeading: string;
  typingHeading: string;
  insightQueueHeading: string;
  verbHeading: string;
  confidencePrefix: string;
  /** 확신 밴드 (ISSUE-372) — 0.82 같은 생수 대신 말로, 생수는 괄호로 남긴다(정보량 무변). */
  confidenceHigh: string;
  confidenceMid: string;
  confidenceLow: string;
  sourceNotePrefix: string;
  contradictionDesc: string;
  gapDesc: string;
  retractEdgeBtn: string;
  keepBothBtn: string;
  confirmBtn: string;
  acceptBtn: string;
  rejectBtn: string;
  verbObservedDesc: string;
  verbIdPlaceholder: string;
  // 온보딩 (S1)
  onboardingTitle: string;
  stepHubConnect: string;
  stepHubConnectDesc: string;
  checkConnectionBtn: string;
  connectionCheckFailed: string;
  stepChooseVault: string;
  useThisVaultBtn: string;
  stepConsent: string;
  consentBtn: string;
  stepInitialIndex: string;
  doneSuffix: string;
  notYetSuffix: string;
  startIndexBtn: string;
  initialIndexDone: string;
  initialIndexHeldSuffix: string;
  indexFailed: string;
  highlightsHeading: string;
  highlightContradiction: string;
  highlightGap: string;
  highlightConnection: string;
  // 설정 탭
  settingsNetworkNote: string;
  hubUrlName: string;
  hubKeyName: string;
  hubKeyDesc: string;
  graphHomeName: string;
  graphHomeDesc: string;
  graphHomePlaceholder: string;
  moveBtn: string;
  homeMoved: string;
  homeMoveFailed: string;
  dbPlaceName: string;
  dbPlaceDesc: string;
  dbSqliteOption: string;
  dbPgOption: string;
  dbPlaceChanged: string;
  workspaceName: string;
  workspaceDesc: string;
  myWorkspacesBtn: string;
  noWorkspaces: string;
  workspaceListFailed: string;
  byoUrlName: string;
  byoUrlDesc: string;
  byoModelName: string;
  byoModelDesc: string;
  byoKeyName: string;
  byoKeyDesc: string;
  externalSourcesName: string;
  externalSourcesDesc: string;
  openConsoleBtn: string;
  hubUrlFirst: string;
  sourcesHeading: string;
  sourcesHeadingDesc: string;
  unregisterBtn: string;
  sourceUnregistered: string;
  sourceUnregisterFailed: string;
  registerSourceName: string;
  registerSourceDesc: string;
  sourceIdPlaceholder: string;
  sourceKindMd: string;
  sourceKindLogseq: string;
  sourceKindBear: string;
  sourceRootPlaceholder: string;
  registerBtn: string;
  sourceRegistered: string;
  sourceRegisterFailed: string;
  synthesisDirName: string;
  synthesisDirDesc: string;
  synthesisDirPlaceholder: string;
  synthesisDirMoved: string;
  synthesisDirMoveFailed: string;
}

export const PLUGIN_STRINGS: Record<PluginLocale, PluginStrings> = {
  ko: {
    cmdOnboarding: "온보딩",
    cmdReview: "검토함",
    cmdSyncNote: "현재 노트 동기화",
    cmdExportJsonld: "JSON-LD 내보내기",
    cmdExportGraphml: "GraphML 내보내기",
    cmdRetryHeld: "보류된 추출 재시도",
    cmdImportSources: "가져오기 소스 따라잡기",
    cmdSynthesize: "소스 정리 노트 합성",
    cmdSyncNotion: "Notion 으로 동기화",
    cmdSyncPostgres: "PostgreSQL 로 동기화",
    projSyncDone: "{dest} 동기화 완료 — {n}건 반영, 보류 {held}건.",
    projSyncInterrupted: "{dest} 동기화가 중단됐습니다 — 다음 실행이 이어서 진행합니다.",
    projSyncFailed: "{dest} 동기화에 실패했습니다: {msg}",
    synthDelivered: "정리 노트를 {dest} 로 보냈습니다.",
    synthDeliverSkipped: "{dest} 전송은 건너뛰었습니다: {msg}",
    cmdWeeklyReport: "주간 리포트 지금 만들기",
    cmdShareNote: "현재 노트를 워크스페이스에 공유",
    cmdRetractShare: "현재 노트 공유 거두기",
    startFailed: "OntoFlow 시작에 실패했습니다: {msg}",
    collectFailed: "OntoFlow 가져오기에 실패했습니다: {msg}",
    eventsDeferred: "그래프 연결 전의 편집을 대기해 두었습니다 — 연결되면 자동으로 반영됩니다(유실 없음)",
    inboxDrained: "원격 캡처 {n}건이 수신함으로 내려왔습니다",
    inboxDrainFailed: "수신함 내리기에 실패했습니다(캡처는 서버 데이터베이스에 남아 있습니다): {msg}",
    dbFlushFailed: "데이터베이스 반영에 실패했습니다: {msg} — 플러그인을 재시작하면 다시 불러옵니다",
    workspaceProjectionFailed: "워크스페이스 동기화에 실패했습니다: {msg}",
    heldTail: "노트 {n}건이 보류로 쌓였습니다(유실 없음) — 「보류된 추출 재시도」 커맨드로 다시 보낼 수 있습니다",
    walletClosedFallback: "크레딧 지갑이 닫혀 있습니다",
    hubUnreachableHeld: "허브에 닿지 않습니다 — {held}",
    usage80: "크레딧 지갑의 80% 를 썼습니다 — 잔량·소진 예측은 허브 콘솔 「사용량」에서 보실 수 있습니다",
    usage100: "크레딧 지갑이 소진됐습니다 — 이후 추출·합성은 보류로 쌓입니다(유실 없음). 팩 충전·업그레이드는 허브 콘솔에서 하실 수 있습니다",
    noHeld: "보류된 추출이 없습니다",
    heldProcessed: "보류 {n}건을 처리했습니다 — 엣지 +{added}",
    noSources: "등록된 가져오기 소스가 없습니다",
    bearMacOnly: "Bear 가져오기({id})는 macOS 전용입니다 — 이 기기에서는 쉽니다",
    bearMissing: "Bear 를 찾지 못했습니다({id}) — 설치·권한을 확인해 주세요: {path}",
    bearEncryptedSkipped: "Bear 암호화 노트 {n}건은 가져오지 않습니다",
    sourcesCollected: "소스 {n}곳 — 변경 {changes}건을 가져왔습니다",
    sourceReaderMissing: "리더가 없는 소스입니다: {id}",
    sourceListFailed: "연결된 소스 조회에 실패했습니다: {msg}",
    sourceIdCollision: "소스 id 충돌 — 로컬 소스 \"{id}\" 와 이름이 같아 API 가져오기를 쉽니다",
    apiSourceCollected: "{kind} — 변경 {n}건을 가져왔습니다",
    apiSourceFailed: "{kind} 가져오기에 실패했습니다: {msg}",
    nothingToSynthesize: "합성할 소스가 없습니다",
    synthesized: "합성했습니다: {path}",
    synthesizeFailed: "합성에 실패했습니다({id}): {msg}",
    insightNotDue: "인사이트 주기가 아직 돌아오지 않았습니다 — 강제 실행 오류입니다 (버그)",
    weeklyReportReady: "주간 리포트가 섰습니다: {path}",
    insightPendingSuffix: " · 확인 대기 +{n}",
    nothingToSay: "전할 것이 없습니다 — 새 변화·모순·공백이 없어 리포트를 생략합니다",
    insightFailed: "인사이트 생성에 실패했습니다: {msg}",
    noNoteToSync: "동기화할 노트가 열려 있지 않습니다",
    syncedNote: "동기화했습니다: {path}",
    syncUnchanged: "변경이 없어 쓰지 않았습니다",
    syncFailed: "동기화에 실패했습니다: {msg}",
    dbNotOpen: "데이터베이스가 아직 열리지 않았습니다",
    exported: "내보냈습니다: {file}",
    exportFailed: "내보내기에 실패했습니다: {msg}",
    noNoteToShare: "열린 노트가 없습니다 — 공유 표시는 현재 노트 단위입니다",
    noWorkspaceSelected: "워크스페이스가 선택되지 않았습니다 — 설정 탭에서 먼저 골라 주세요",
    shared: "워크스페이스에 공유로 표시했습니다 — {path}",
    unshared: "공유 표시를 거뒀습니다 — {path}",
    shareFailed: "공유 표시에 실패했습니다: {msg}",
    reviewTitle: "OntoFlow 검토함",
    reviewFailed: "검토 처리에 실패했습니다: {msg}",
    mergeHeading: "병합 제안 ({n})",
    typingHeading: "타이핑 제안 ({n})",
    insightQueueHeading: "인사이트 확인 대기 ({n})",
    verbHeading: "동사 제안 ({n})",
    confidencePrefix: "확신 {band} ({v})",
    confidenceHigh: "높음",
    confidenceMid: "중간",
    confidenceLow: "낮음",
    sourceNotePrefix: "출처 {note}",
    contradictionDesc: "모순 — 한쪽을 철회하시거나 둘 다 유지하실 수 있습니다",
    gapDesc: "공백 — 확인하시면 다시 묻지 않습니다",
    retractEdgeBtn: "「{edge}」 철회",
    keepBothBtn: "둘 다 유지",
    confirmBtn: "확정",
    acceptBtn: "수락",
    rejectBtn: "기각",
    verbObservedDesc: "관측 {n}회 · 추천 상위분류 {superclass}",
    verbIdPlaceholder: "동사 id (예: refers-to)",
    onboardingTitle: "OntoFlow 온보딩",
    stepHubConnect: "허브 연결 {state}",
    stepHubConnectDesc: "설정 탭에서 허브 주소와 API 키(허브 콘솔 「계정」에서 발급)를 먼저 넣어 주세요.",
    checkConnectionBtn: "연결 확인",
    connectionCheckFailed: "연결 확인에 실패했습니다: {msg}",
    stepChooseVault: "vault 선택 {state}",
    useThisVaultBtn: "이 vault 사용",
    stepConsent: "민감정보 별도 동의 {state}",
    consentBtn: "동의합니다",
    stepInitialIndex: "최초 색인 — {progress}{done}",
    doneSuffix: " (완료)",
    notYetSuffix: "— 전",
    startIndexBtn: "색인 시작",
    initialIndexDone: "최초 색인이 끝났습니다 — 노트 {n}",
    initialIndexHeldSuffix: " · 보류 {n}",
    indexFailed: "색인에 실패했습니다: {msg}",
    highlightsHeading: "노트에서 이런 것이 나왔습니다",
    highlightContradiction: "모순",
    highlightGap: "공백",
    highlightConnection: "의외의 연결",
    settingsNetworkNote:
      "기본값은 외부 전송 0 입니다 — 허브 주소·API 키를 넣고 민감정보 동의를 마칠 때까지 노트는 이 기기를 떠나지 않습니다. " +
      "연결한 뒤에는 추출을 위해 노트 본문이 모아요 허브(보관 0 · zero-retention)로 갑니다. " +
      "BYO 엔드포인트를 설정하면 추출은 그 주소로만 가고 본문은 기기를 떠나지 않습니다. 텔레메트리·사용 분석은 없습니다.",
    hubUrlName: "허브 주소",
    hubKeyName: "허브 API 키",
    hubKeyDesc:
      "허브 콘솔 「계정」에서 발급한 API 키(ofk_…) — 만료가 없어 한 번 넣으면 됩니다. 키는 이 플러그인 설정 저장소에만 살고 로그·노트 본문에 실리지 않습니다.",
    graphHomeName: "그래프 홈 지정",
    graphHomeDesc: "데이터베이스(.ontoflow)의 보관 자리 — vault 안 경로만 가능합니다(모바일은 vault 밖에 닿지 않습니다).",
    graphHomePlaceholder: "예: 90-시스템/ontoflow",
    moveBtn: "이동",
    homeMoved: "홈 이동이 끝났습니다 — 옮긴 파일 {n}",
    homeMoveFailed: "홈 이동에 실패했습니다: {msg}",
    dbPlaceName: "데이터베이스 자리",
    dbPlaceDesc:
      "sqlite = 그래프 홈 파일(기본) · pg = 사용자 소유 PostgreSQL — 허브 금고에 postgres 자격증명 등록이 먼저입니다. 전환 시 자동 이관은 없습니다(내보내기·가져오기 경유).",
    dbSqliteOption: "SQLite (기본)",
    dbPgOption: "PostgreSQL (사용자 소유)",
    dbPlaceChanged: "데이터베이스 자리를 바꿨습니다 — 플러그인 재시작(비활성/활성) 시 적용됩니다",
    workspaceName: "워크스페이스",
    workspaceDesc:
      "멤버로 일할 워크스페이스 id — 비우면 개인입니다. 서 있으면 추출·합성 크레딧이 워크스페이스 풀에서 나가고, 그래프 사본이 워크스페이스 데이터베이스의 내 자리로 동기화됩니다(워크스페이스가 보는 것은 공유로 표시한 것뿐입니다). 「내 워크스페이스」가 id 를 보여 줍니다.",
    myWorkspacesBtn: "내 워크스페이스",
    noWorkspaces: "소속된 워크스페이스가 없습니다 — 초대·가입은 허브 콘솔에서 하실 수 있습니다",
    workspaceListFailed: "워크스페이스 조회에 실패했습니다: {msg}",
    byoUrlName: "BYO 추출 엔드포인트",
    byoUrlDesc:
      "OpenAI 호환 주소(예: http://localhost:11434 — Ollama·vLLM·LM Studio). 모델명과 함께 설정하면 추출이 이 엔드포인트로만 갑니다 — 노트 본문이 기기를 떠나지 않습니다. 품질 게이트 밖(비보증)이며, 비우면 모아요 서빙(기본)입니다.",
    byoModelName: "BYO 모델명",
    byoModelDesc: "엔드포인트에 떠 있는 모델 이름 — 선택은 사용자 몫입니다(품질 비보증).",
    byoKeyName: "BYO API 키 (선택)",
    byoKeyDesc:
      "로컬 엔드포인트는 보통 비워 둡니다. 키는 이 설정 저장소에만 살고 BYO 호출 헤더로만 흐릅니다 — 허브에 실리지 않습니다.",
    externalSourcesName: "외부 소스 연결",
    externalSourcesDesc:
      "OneNote·Notion·Google Drive·Dropbox 등을 토큰 발급 없이 연결합니다 — 허브 콘솔의 「연결」 버튼이 동의 화면으로 안내하고, 토큰은 금고로 직행합니다(이 플러그인은 토큰을 보지 않습니다).",
    openConsoleBtn: "연결 관리 열기",
    hubUrlFirst: "허브 주소를 먼저 설정해 주세요",
    sourcesHeading: "가져오기 소스",
    sourcesHeadingDesc: "vault 밖 md 폴더(일반·Logseq·클라우드 동기화 폴더) — 읽기 전용 가져오기, 데스크톱 전용입니다.",
    unregisterBtn: "해제",
    sourceUnregistered: "소스를 해제했습니다: {id} — 이후 변경은 가져오지 않습니다",
    sourceUnregisterFailed: "소스 해제에 실패했습니다: {msg}",
    registerSourceName: "소스 등록",
    registerSourceDesc: "id 는 소문자·숫자·하이픈, 경로는 폴더 절대 경로입니다.",
    sourceIdPlaceholder: "id (예: logseq-main)",
    sourceKindMd: "md 폴더",
    sourceKindLogseq: "Logseq",
    sourceKindBear: "Bear (macOS)",
    sourceRootPlaceholder: "/Users/…/폴더",
    registerBtn: "등록",
    sourceRegistered: "소스를 등록했습니다: {id}",
    sourceRegisterFailed: "소스 등록에 실패했습니다: {msg}",
    synthesisDirName: "합성 자리 지정",
    synthesisDirDesc: "정리 노트(기계 소유물)가 서는 폴더 — 기본 ontoflow-notes. 이동 시 기존 합성 노트도 함께 옮깁니다.",
    synthesisDirPlaceholder: "예: 90-시스템/정리",
    synthesisDirMoved: "합성 자리를 옮겼습니다 — {dir} (노트 {n})",
    synthesisDirMoveFailed: "합성 자리 이동에 실패했습니다: {msg}",
  },
  en: {
    cmdOnboarding: "Onboarding",
    cmdReview: "Review inbox",
    cmdSyncNote: "Sync current note",
    cmdExportJsonld: "Export JSON-LD",
    cmdExportGraphml: "Export GraphML",
    cmdRetryHeld: "Retry held extractions",
    cmdImportSources: "Catch up import sources",
    cmdSynthesize: "Synthesize source digest notes",
    cmdSyncNotion: "Sync to Notion",
    cmdSyncPostgres: "Sync to PostgreSQL",
    projSyncDone: "{dest} sync complete — {n} applied, {held} held.",
    projSyncInterrupted: "{dest} sync was interrupted — the next run resumes where it left off.",
    projSyncFailed: "{dest} sync failed: {msg}",
    synthDelivered: "Sent the synthesis note to {dest}.",
    synthDeliverSkipped: "Skipped delivery to {dest}: {msg}",
    cmdWeeklyReport: "Generate weekly report now",
    cmdShareNote: "Share current note with workspace",
    cmdRetractShare: "Unshare current note",
    startFailed: "OntoFlow failed to start: {msg}",
    collectFailed: "OntoFlow import failed: {msg}",
    eventsDeferred: "Edits made before the graph connected are queued — they sync automatically once it is ready (nothing lost)",
    inboxDrained: "{n} remote capture(s) arrived in your inbox",
    inboxDrainFailed: "Draining the inbox failed (captures stay on the server database): {msg}",
    dbFlushFailed: "Database write failed: {msg} — restart the plugin to reload",
    workspaceProjectionFailed: "Workspace sync failed: {msg}",
    heldTail: "{n} note(s) are held (nothing lost) — run “Retry held extractions” to send them again",
    walletClosedFallback: "Your credit wallet is closed",
    hubUnreachableHeld: "The hub is unreachable — {held}",
    usage80: "You have used 80% of your credit wallet — see balance and forecast in the hub console under Usage",
    usage100:
      "Your credit wallet is used up — further extraction and synthesis are held (nothing lost). Buy a pack or upgrade in the hub console",
    noHeld: "No held extractions",
    heldProcessed: "Processed {n} held note(s) — edges +{added}",
    noSources: "No import sources registered",
    bearMacOnly: "Bear import ({id}) is macOS-only — it rests on this device",
    bearMissing: "Could not find Bear ({id}) — check installation and permissions: {path}",
    bearEncryptedSkipped: "{n} encrypted Bear note(s) are not imported",
    sourcesCollected: "{n} source(s) — imported {changes} change(s)",
    sourceReaderMissing: "Source has no reader: {id}",
    sourceListFailed: "Could not list connected sources: {msg}",
    sourceIdCollision: "Source id collision — a local source is also named \"{id}\", so API import rests",
    apiSourceCollected: "{kind} — imported {n} change(s)",
    apiSourceFailed: "{kind} import failed: {msg}",
    nothingToSynthesize: "Nothing to synthesize",
    synthesized: "Synthesized: {path}",
    synthesizeFailed: "Synthesis failed ({id}): {msg}",
    insightNotDue: "The insight cycle is not due yet — forced run error (bug)",
    weeklyReportReady: "Weekly report is ready: {path}",
    insightPendingSuffix: " · awaiting review +{n}",
    nothingToSay: "Nothing to report — no new changes, contradictions or gaps, so the report is skipped",
    insightFailed: "Insight generation failed: {msg}",
    noNoteToSync: "No note is open to sync",
    syncedNote: "Synced: {path}",
    syncUnchanged: "No changes — nothing written",
    syncFailed: "Sync failed: {msg}",
    dbNotOpen: "The database is not open yet",
    exported: "Exported: {file}",
    exportFailed: "Export failed: {msg}",
    noNoteToShare: "No note is open — sharing marks the current note",
    noWorkspaceSelected: "No workspace selected — pick one in the settings tab first",
    shared: "Marked as shared with your workspace — {path}",
    unshared: "Removed the shared mark — {path}",
    shareFailed: "Sharing failed: {msg}",
    reviewTitle: "OntoFlow review inbox",
    reviewFailed: "Review action failed: {msg}",
    mergeHeading: "Merge proposals ({n})",
    typingHeading: "Typing proposals ({n})",
    insightQueueHeading: "Insights awaiting review ({n})",
    verbHeading: "Verb proposals ({n})",
    confidencePrefix: "confidence {band} ({v})",
    confidenceHigh: "high",
    confidenceMid: "medium",
    confidenceLow: "low",
    sourceNotePrefix: "source {note}",
    contradictionDesc: "Contradiction — retract one side, or keep both",
    gapDesc: "Gap — confirm it and it will not be asked again",
    retractEdgeBtn: "Retract “{edge}”",
    keepBothBtn: "Keep both",
    confirmBtn: "Confirm",
    acceptBtn: "Accept",
    rejectBtn: "Reject",
    verbObservedDesc: "observed {n}× · suggested superclass {superclass}",
    verbIdPlaceholder: "verb id (e.g. refers-to)",
    onboardingTitle: "OntoFlow onboarding",
    stepHubConnect: "Connect hub {state}",
    stepHubConnectDesc: "Enter the hub address and an API key (issued in the hub console under Account) in the settings tab first.",
    checkConnectionBtn: "Check connection",
    connectionCheckFailed: "Connection check failed: {msg}",
    stepChooseVault: "Choose vault {state}",
    useThisVaultBtn: "Use this vault",
    stepConsent: "Sensitive-data consent {state}",
    consentBtn: "I consent",
    stepInitialIndex: "Initial index — {progress}{done}",
    doneSuffix: " (done)",
    notYetSuffix: "— pending",
    startIndexBtn: "Start indexing",
    initialIndexDone: "Initial index finished — {n} note(s)",
    initialIndexHeldSuffix: " · held {n}",
    indexFailed: "Indexing failed: {msg}",
    highlightsHeading: "This came out of your notes",
    highlightContradiction: "Contradiction",
    highlightGap: "Gap",
    highlightConnection: "Unexpected connection",
    settingsNetworkNote:
      "The default is zero outbound transfer — until you enter the hub address and API key and complete the sensitive-data consent, your notes never leave this device. " +
      "Once connected, note bodies go to the Moayo hub (zero retention) for extraction. " +
      "With a BYO endpoint configured, extraction goes only to that address and bodies never leave the device. No telemetry or usage analytics.",
    hubUrlName: "Hub address",
    hubKeyName: "Hub API key",
    hubKeyDesc:
      "An API key issued in the hub console under Account (ofk_…) — it does not expire, so you enter it once. It lives only in this plugin's settings store and never appears in logs or note bodies.",
    graphHomeName: "Set graph home",
    graphHomeDesc: "Where the database (.ontoflow) lives — a path inside the vault only (mobile cannot reach outside the vault).",
    graphHomePlaceholder: "e.g. 90-system/ontoflow",
    moveBtn: "Move",
    homeMoved: "Home moved — {n} file(s) relocated",
    homeMoveFailed: "Moving home failed: {msg}",
    dbPlaceName: "Database home",
    dbPlaceDesc:
      "sqlite = a file in the graph home (default) · pg = your own PostgreSQL — register the postgres credential in the hub vault first. No automatic migration on switch (go through export/import).",
    dbSqliteOption: "SQLite (default)",
    dbPgOption: "PostgreSQL (your own)",
    dbPlaceChanged: "Database home changed — takes effect when the plugin restarts (disable/enable)",
    workspaceName: "Workspace",
    workspaceDesc:
      "The workspace id you work in as a member — leave empty for personal. When set, extraction and synthesis credits come from the workspace pool, and a copy of your graph syncs to your seat in the workspace database (the workspace sees only what you mark as shared). “My workspaces” shows the ids.",
    myWorkspacesBtn: "My workspaces",
    noWorkspaces: "You are not in any workspace — invites and joining happen in the hub console",
    workspaceListFailed: "Could not list workspaces: {msg}",
    byoUrlName: "BYO extraction endpoint",
    byoUrlDesc:
      "An OpenAI-compatible address (e.g. http://localhost:11434 — Ollama, vLLM, LM Studio). With a model name set, extraction goes only to this endpoint — note bodies never leave the device. Outside the quality gate (no guarantee); leave empty for Moayo serving (default).",
    byoModelName: "BYO model name",
    byoModelDesc: "The model served at the endpoint — the choice is yours (no quality guarantee).",
    byoKeyName: "BYO API key (optional)",
    byoKeyDesc:
      "Usually empty for local endpoints. The key lives only in this settings store and flows only in BYO request headers — it never reaches the hub.",
    externalSourcesName: "Connect external sources",
    externalSourcesDesc:
      "Connect OneNote, Notion, Google Drive, Dropbox and more without issuing tokens — the hub console's Connect button walks you through consent, and tokens go straight to the vault (this plugin never sees them).",
    openConsoleBtn: "Open connection manager",
    hubUrlFirst: "Set the hub address first",
    sourcesHeading: "Import sources",
    sourcesHeadingDesc: "md folders outside the vault (plain, Logseq, cloud-sync folders) — read-only import, desktop only.",
    unregisterBtn: "Remove",
    sourceUnregistered: "Source removed: {id} — further changes are not imported",
    sourceUnregisterFailed: "Removing the source failed: {msg}",
    registerSourceName: "Register a source",
    registerSourceDesc: "The id is lowercase letters, digits and hyphens; the path is an absolute folder path.",
    sourceIdPlaceholder: "id (e.g. logseq-main)",
    sourceKindMd: "md folder",
    sourceKindLogseq: "Logseq",
    sourceKindBear: "Bear (macOS)",
    sourceRootPlaceholder: "/Users/…/folder",
    registerBtn: "Register",
    sourceRegistered: "Source registered: {id}",
    sourceRegisterFailed: "Registering the source failed: {msg}",
    synthesisDirName: "Set synthesis home",
    synthesisDirDesc: "The folder where digest notes (machine-owned) live — default ontoflow-notes. Moving relocates existing digest notes too.",
    synthesisDirPlaceholder: "e.g. 90-system/digests",
    synthesisDirMoved: "Synthesis home moved — {dir} ({n} note(s))",
    synthesisDirMoveFailed: "Moving the synthesis home failed: {msg}",
  },
};

/** 로케일 한 벌 — 플러그인 로드 시 한 번 고른다(옵시디언 언어 변경은 재시작을 동반한다). */
export function pluginStrings(): PluginStrings {
  return PLUGIN_STRINGS[detectLocale()];
}
