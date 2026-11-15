// 온보딩 (S1) — 허브 연결 → vault 선택 → `§23` 민감정보 별도 동의 → 최초 색인, 한 흐름
// (이슈 #12 AC1·AC2). 동의가 처리의 선행 조건이다(스펙 AC40 · moayo-hq#272 결의 9) —
// 동의 전에는 색인이 시작되지 않는다. 상태의 자리는 그래프 홈 (기본 `.ontoflow/` — 설계 결정 ⓐ, #31 지정 가능).
// 허브 토큰 값 자체는 여기 저장하지 않는다 — 연결 사실만 든다(토큰 보관은 플러그인 설정 몫).
import { resolveHome, type FileIo } from "./store.js";

export const ONBOARDING_FILE = "onboarding.json";
export const ONBOARDING_SCHEMA_VERSION = 1;

export class OnboardingError extends Error {
  constructor(readonly problems: string[]) {
    super(`온보딩 실패:\n- ${problems.join("\n- ")}`);
    this.name = "OnboardingError";
  }
}

export interface OnboardingState {
  schema: typeof ONBOARDING_SCHEMA_VERSION;
  hubConnected: boolean;
  vaultChosen: boolean;
  /** `§23` 별도 동의 — 시각이 기록으로 남는다. null 이면 미동의. */
  consent: { grantedAt: string } | null;
  /** 최초 색인 진행률 — 처리/전체 노트 수 (AC1). null 이면 색인 전. */
  indexing: { total: number; processed: number } | null;
  completedAt: string | null;
}

export function emptyOnboarding(): OnboardingState {
  return {
    schema: ONBOARDING_SCHEMA_VERSION,
    hubConnected: false,
    vaultChosen: false,
    consent: null,
    indexing: null,
    completedAt: null,
  };
}

export function connectHub(state: OnboardingState): OnboardingState {
  return { ...state, hubConnected: true };
}

export function chooseVault(state: OnboardingState): OnboardingState {
  return { ...state, vaultChosen: true };
}

export function grantConsent(state: OnboardingState, grantedAt: string): OnboardingState {
  return { ...state, consent: { grantedAt } };
}

// 최초 색인의 입구 — 동의 없이는 시작 자체가 없다 (AC2, 스펙 AC40).
export function startInitialIndex(state: OnboardingState, totalNotes: number): OnboardingState {
  const problems: string[] = [];
  if (!state.hubConnected) problems.push("허브가 연결되지 않았다");
  if (!state.vaultChosen) problems.push("vault 가 선택되지 않았다");
  if (state.consent === null) {
    problems.push("`§23` 별도 동의 전이다 — 동의가 처리의 선행 조건이다");
  }
  if (!Number.isInteger(totalNotes) || totalNotes < 0) {
    problems.push(`전체 노트 수가 음이 아닌 정수가 아니다: ${totalNotes}`);
  }
  if (problems.length > 0) throw new OnboardingError(problems);
  return { ...state, indexing: { total: totalNotes, processed: 0 } };
}

// 진행률 갱신 — 전체에 닿으면 온보딩 완료가 찍힌다.
export function recordIndexProgress(
  state: OnboardingState,
  processed: number,
  now: string,
): OnboardingState {
  if (state.indexing === null) {
    throw new OnboardingError(["색인이 시작되지 않았다 — 진행률을 기록할 자리가 없다"]);
  }
  if (!Number.isInteger(processed) || processed < 0 || processed > state.indexing.total) {
    throw new OnboardingError([`처리 수가 [0, ${state.indexing.total}] 밖이다: ${processed}`]);
  }
  const indexing = { ...state.indexing, processed };
  const done = processed === state.indexing.total;
  return { ...state, indexing, completedAt: done ? state.completedAt ?? now : state.completedAt };
}

/**
 * 실패 원복 (ISSUE-431) — 시작 표식만 남으면 「색인 시작」 버튼이 영구 비활성이다(막다른 길):
 * 추출·교체가 실패하면 시작 전 상태로 되돌려 재시도의 문을 연다. 완료 기록(completedAt)은
 * 건드리지 않는다 — 완료 뒤의 재색인 실패도 완료 사실을 지우지 않는다.
 */
export function abortInitialIndex(state: OnboardingState): OnboardingState {
  if (state.indexing === null) return state;
  return { ...state, indexing: null };
}

// 화면이 그릴 진행 표기 — 처리/전체 (AC1).
export function progressLabel(state: OnboardingState): string {
  if (state.indexing === null) return "색인 전";
  return `${state.indexing.processed}/${state.indexing.total}`;
}

// ---- 영속 — collect.json 과 같은 규율 ----

export async function loadOnboarding(io: FileIo, vaultDir: string): Promise<OnboardingState> {
  const home = await resolveHome(io, vaultDir);
  const text = await io.readText(`${home.dir}/${ONBOARDING_FILE}`);
  if (text === null) return emptyOnboarding();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new OnboardingError([`${ONBOARDING_FILE} 이 JSON 이 아니다: ${(e as Error).message}`]);
  }
  const state = parsed as OnboardingState;
  if (state?.schema !== ONBOARDING_SCHEMA_VERSION) {
    throw new OnboardingError([`${ONBOARDING_FILE} 스키마가 맞지 않는다 (기대 ${ONBOARDING_SCHEMA_VERSION})`]);
  }
  return state;
}

export async function saveOnboarding(
  io: FileIo,
  vaultDir: string,
  state: OnboardingState,
): Promise<void> {
  const { dir } = await resolveHome(io, vaultDir);
  await io.mkdir(dir);
  const path = `${dir}/${ONBOARDING_FILE}`;
  const tmp = `${path}.tmp`;
  await io.writeText(tmp, JSON.stringify(state));
  await io.rename(tmp, path);
}
