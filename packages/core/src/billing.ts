// 회원·과금·무료 층 (F11 · API5 · S3·S4) — 유일한 지불 실물(호스티드 처리 서비스)의 자리
// (이슈 #16 · moayo-hq#269). MoR 구도는 소진된 결정이다: Polar 외부 체크아웃만 — 카드
// 정보가 우리 표면을 지나는 경로 자체를 만들지 않는다 (AC1 · moayo-hq#272 결의 6).
// 허브 쪽 모듈 — 회원·구독·집계는 금고와 함께 허브가 드는 영속 상태지만, 사용자 콘텐츠가
// 아니라 계정·상태·건수뿐이다 (보관 0 과 양립). 영속 어댑터는 경계 밖, 여기는 판정만 산다.
// 잎 타입 모듈에서 직접 문다 (#326) — 금고·검증 모듈을 타입으로 물면 공개 미러의 전이
// 폐쇄가 서버 모듈을 끌고 온다.
import type { Destination } from "./destination.js";
import type { HubApiKey } from "./api-keys.js";
import type { Passkey } from "./passkey.js";
import {
  CREDIT_PACK,
  FREE_MONTHLY_CREDITS as FREE_CREDITS,
  FREE_PLAN,
  assertSubscribable,
  creditsForChars,
  planOf,
  PLANS_COHORT,
  quotaOf,
  rankOf,
  priceUsdOf,
  type BillingInterval,
  type Plan,
  type PlanId,
} from "./plans.js";

// `Subscription.plan` · `ConsoleView.plan` 이 이 타입을 싣는다 — 이 모듈의 공개 표면에
// 올라오므로 여기서 함께 수출한다 (호출자가 `plans.js` 를 따로 알 필요가 없다).
export type { BillingInterval, Plan, PlanId } from "./plans.js";
export { CREDIT_PACK } from "./plans.js"; // 팩 상수 — 콘솔·허브가 billing 표면 하나로 읽는다

export class BillingError extends Error {
  constructor(
    readonly status: number,
    readonly problems: string[],
  ) {
    super(`과금 거부 (${status}):\n- ${problems.join("\n- ")}`);
    this.name = "BillingError";
  }
}

// ---- 계정 — 조직 확장형 스키마 (조직 기능 자체는 비범위 — moayo-hq#272 기록 항목) ----

/**
 * 로그인 수단 하나 (#110) — Firebase 공급자 id 와 그 공급자가 준 안정 식별자.
 *
 * `subject` 는 Firebase uid 다. **계정 키가 아니다** — 계정 키는 우리 uuid 이고, 이 값은
 * 「그 계정에 붙은 문 하나」의 이름일 뿐이다. 문이 닫혀도(구글 계정 삭제·Workspace 계정
 * 삭제·정지) 계정은 남고 다른 문으로 들어온다.
 */
export interface AuthProvider {
  /** `google.com` · `password` 등 — Firebase 의 `firebase.sign_in_provider` 값. */
  provider: string;
  /** 그 공급자가 준 안정 식별자 (Firebase uid). */
  subject: string;
}

export interface Account {
  /**
   * 우리 것 — uuid. 공급자가 바뀌어도 이 값은 안 바뀐다 (#110).
   *
   * ⚠️ **한때 Firebase uid 였다.** 그러면 공급자 상실이 곧 계정 상실이고(구독은 도는데
   * 해지 1클릭을 행사할 수 없다), `CLAUDE.md` §1 이 열어 둔 「Firebase 전환 조건은 결의」가
   * 코드에서 선택지가 아니게 된다. 사용자 0명 시점에 바꿨다 — 그 뒤엔 전 계정 재키잉이다.
   */
  id: string;
  /** v1 은 1인 조직 — 자기 조직 하나. 스키마만 확장형으로 둔다. */
  orgId: string;
  /**
   * 계정의 축이자 복구의 끈 (#110) — 처리방침 §1 이 수집을 적어 둔 그 값이다.
   * 같은 사람의 두 번째 공급자를 같은 계정에 붙이는 판정이 이 값으로 선다.
   */
  email: string;
  /** 같은 계정에 붙은 로그인 수단들 — 하나가 사라져도 나머지로 들어온다 (#110). */
  authProviders: readonly AuthProvider[];
  /**
   * 등록된 패스키 (#112). **`authProviders` 와 따로 산다** — #111 이 세운 완성 게이트는
   * 비밀번호 자격 보유이고 패스키가 그것을 갈음하면 안 된다(이 티켓의 「패스키 하나로 바꾸면
   * 고아가 옮겨간다」). 구조적으로도 패스키만 가진 계정은 생길 수 없다: 등록이 **로그인
   * 상태에서만** 되기 때문이다.
   * ⭐ 담기는 것은 **공개 키와 식별자뿐**이다 — 비밀이 아니다.
   * 옛 레코드에는 이 칸이 없을 수 있다(사용자 0명 시점 추가라 마이그레이션 0).
   */
  passkeys?: readonly Passkey[];
  /**
   * 허브 API 키 (ISSUE-363) — 장수 기계 자격: 평문은 발급 응답 한 번뿐이고 여기는 해시만
   * 산다. 처리면 허용 목록만 지난다(`api-keys.ts`) — 계정 자격을 갈음하지 않는다.
   * 옛 레코드에는 이 칸이 없을 수 있다(사용자 0명 시점 추가라 마이그레이션 0).
   */
  apiKeys?: readonly HubApiKey[];
  createdAt: string;
  /** `§23` 민감정보 별도 동의 — 가입과 분리된 단계(S4)다. null = 미동의 = 처리 0 (AC4).
   * version 없음 = 구 문안(v1 — 외부 소스 수집 미포함, #60 재동의 게이트의 분모). */
  sensitiveConsent: { grantedAt: string; version?: number } | null;
  /**
   * 마케팅 수신동의 (ISSUE-242 AC6 · C3) — **기본 미동의**다: 칸 부재·null = 동의 없음이고,
   * 명시 opt-in 만 시각·방법과 함께 기록된다(§50① 증빙). 거래 고지(80/100% 임계 등)는 이
   * 동의와 무관하다 — C2 근거는 MARKETING_TRANSACTIONAL_BASIS.
   */
  marketingConsent?: { grantedAt: string; method: string } | null;
  /**
   * 약관·처리방침 동의 증적 (ISSUE-245 결함 수정 — 가입 의식에 동의 체크가 없었다).
   * 가입 의식의 필수 체크 둘(이용약관 동의 · 처리방침 확인)이 지나간 시각이다 — §23 민감정보
   * 동의(sensitiveConsent)와는 **다른 축**이라 섞지 않는다. 칸 부재 = 구 가입(기록 전) 또는
   * 미완성이고, 기록은 더하기만 한다(철회 함수 없음 — 약관 동의 철회는 탈퇴다).
   */
  termsConsent?: { grantedAt: string } | null;
  /**
   * 자리 제공 표식 (ISSUE-305 · moayo-hq#302 판정) — 모아요가 제공한 개인 DB 자리를 쓰는
   * 계정. 칸 부재 = 자리 없음(자기 PG 또는 로컬 — 닫힌 기본). 소유 기준으로 **사용자
   * 자리**다: 반출·삭제권이 사용자에게 있고, 전환·탈퇴는 자리 소멸을 동반한다(조직
   * `hosted` 와 같은 결 — ISSUE-242 AC7). 표식의 생애는 `seat.ts` 가 든다.
   */
  hostedSeat?: { provisionedAt: string } | null;
  /**
   * 이메일 축이 처음 인증된 시각 (ISSUE-358) — 칸 부재·null = 한 번도 인증된 적 없음.
   * 인증된 세션이 처음 닿을 때 한 번 찍히고 불변이다. 도장 없는 계정에 인증된 토큰이
   * 이메일 병합으로 닿으면 축의 주인이 그 토큰으로 확정되어 낯선 uid 의 문·패스키가
   * 걷힌다(심어 둔 계정 차단 — `auth.ts` 2단계). 옛 레코드의 칸 부재는 주인의 첫 인증
   * 세션에서 자연 보정된다(마이그레이션 0).
   */
  emailVerifiedAt?: string | null;
}

/**
 * 이메일 축의 정규화 (#110) — 대소문자는 같은 계정이다. 그 밖(점 무시·플러스 태그)은
 * **건드리지 않는다**: 공급자마다 의미가 달라 우리가 판정할 값이 아니고, 잘못 접으면
 * 서로 다른 사람이 한 계정에 들어온다.
 */
export function normalizeEmail(email: string): string | null {
  const trimmed = email.trim().toLowerCase();
  return trimmed.length === 0 ? null : trimmed;
}

// 생성 입력에 동의가 없다 — 가입과 동의가 한 단계로 뭉칠 수 없는 구조 증명 (S4 단계 분리).
// 반대로 **로그인 수단 없는 계정은 서지 않는다** (#110): 들어올 문이 0인 계정을 만드는
// 경로가 있으면 그것이 곧 고아 계정의 공장이다.
export function createAccount(
  id: string,
  email: string,
  providers: readonly AuthProvider[],
  now: string,
): Account {
  const accountId = id.trim();
  if (accountId.length === 0) throw new BillingError(422, ["계정 id 가 비어 있습니다"]);
  const normalized = normalizeEmail(email);
  if (normalized === null) throw new BillingError(422, ["계정 이메일이 비어 있습니다 — 계정의 축입니다"]);
  if (providers.length === 0) throw new BillingError(422, ["로그인 수단이 없는 계정은 서지 않습니다"]);
  return {
    id: accountId,
    orgId: `org:${accountId}`,
    email: normalized,
    authProviders: dedupeProviders(providers),
    createdAt: now,
    sensitiveConsent: null,
  };
}

/** 공급자 중복 제거 — `auth.ts` 의 공급자 동기화도 같은 꼴을 써야 순서가 갈리지 않는다. */
export function dedupeProviders(providers: readonly AuthProvider[]): readonly AuthProvider[] {
  const seen = new Set<string>();
  const kept: AuthProvider[] = [];
  for (const p of providers) {
    const key = `${p.provider}\u0000${p.subject}`;
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push({ provider: p.provider, subject: p.subject });
  }
  return kept;
}

/**
 * 두 번째 문을 같은 계정에 붙인다 (#110 AC3) — 이미 있는 수단이면 그대로 돌려준다(멱등).
 * 계정 id·동의·생성 시각은 건드리지 않는다: 수단이 늘어도 계정의 정체는 그대로다.
 */
export function linkAuthProvider(account: Account, ...providers: readonly AuthProvider[]): Account {
  const merged = dedupeProviders([...account.authProviders, ...providers]);
  if (merged.length === account.authProviders.length) return account;
  return { ...account, authProviders: merged };
}

/** 그 공급자의 문이 이 계정에 있는가. */
export function hasAuthProvider(account: Account, provider: string): boolean {
  return account.authProviders.some((p) => p.provider === provider);
}

/**
 * 문을 뗀다 (#111) — ⛔ **마지막 문은 떼지 않는다.**
 *
 * 문이 0개인 계정은 들어올 길이 없는데 구독은 돌고 금고는 남는 상태, 즉 #110 이 고친 그
 * 고아 계정이다. `createAccount` 가 「로그인 수단이 없는 계정은 서지 않는다」로 세운 규율의
 * **런타임 짝**이고, 둘이 함께 있어야 「생성 경로로도 삭제 경로로도 문 0개를 만들 수 없다」가
 * 성립한다.
 *
 * ⚠️ 호출 순서가 계약이다 — **이 판정이 Firebase 쪽 unlink 보다 먼저**다. 공급자에서 먼저 떼고
 *    물으면, 거절될 때 사용자는 이미 유일한 문을 잃은 상태다 (`server.ts` 의 라우트 주석).
 */
export function unlinkAuthProvider(account: Account, provider: string): Account {
  const kept = account.authProviders.filter((p) => p.provider !== provider);
  if (kept.length === account.authProviders.length) {
    throw new BillingError(404, [`${provider} 는 이 계정에 붙어 있지 않습니다`]);
  }
  if (kept.length === 0) {
    throw new BillingError(409, [
      "마지막 로그인 수단은 뗄 수 없습니다 — 떼면 들어올 문이 0 이 됩니다. 다른 수단을 먼저 붙여 주세요",
    ]);
  }
  return { ...account, authProviders: kept };
}

/** 동의 문안 버전 — v2(#60): 외부 소스 수집 명시. 재동의는 같은 grant 경로다. */
export const CONSENT_VERSION = 2;

export function grantSensitiveConsent(account: Account, grantedAt: string): Account {
  return { ...account, sensitiveConsent: { grantedAt, version: CONSENT_VERSION } };
}

/**
 * 외부 소스 수집의 동의 게이트 (#60 AC3) — 구 문안(v1) 동의는 vault 추출만 덮는다:
 * 수집 시작은 확대 문안(v2) 재동의가 선행 조건이다. 동의 범위 밖 처리 0.
 */
/**
 * C2 자구 (ISSUE-242 AC6 — #221 답변) — 무료 워크스페이스 거래 관계의 §50② 예외 적용 근거:
 * 문서(처리방침·약관)와 화면이 같은 한 문장을 쓴다. 광고성 정보의 축은 별개(opt-in)다.
 */
export const MARKETING_TRANSACTIONAL_BASIS =
  "무료 워크스페이스를 포함한 서비스 이용은 거래 관계이며, 거래 고지(사용량 임계·결제·보안 알림)는 정보통신망법 제50조 제2항(거래 종료 후 6개월 이내)의 예외에 따라 수신동의 없이 발송될 수 있습니다. 광고성 정보는 별도 수신동의 없이는 보내지 않습니다.";

/** 마케팅 수신동의 — opt-in 의 유일한 길: 방법 기록 없는 동의는 서지 않는다 (C3 증빙). */
export function grantMarketingConsent(account: Account, method: string, now: string): Account {
  if (method.trim().length === 0) {
    throw new BillingError(422, ["동의 방법 기록이 비어 있습니다 — 시각·방법이 증빙입니다"]);
  }
  return { ...account, marketingConsent: { grantedAt: now, method: method.trim() } };
}

/**
 * 약관·처리방침 동의 기록 (ISSUE-245) — 가입 의식의 체크 둘이 지나간 뒤 호출된다. 멱등:
 * 이미 기록이 있으면 **처음 시각을 지킨다**(재호출이 증적을 덮어쓰지 않는다).
 */
export function grantTermsConsent(account: Account, now: string): Account {
  if (account.termsConsent != null) return account;
  return { ...account, termsConsent: { grantedAt: now } };
}

/** 철회 — 즉시 미동의로 돌아간다. 거래 고지는 영향 없다 (MARKETING_TRANSACTIONAL_BASIS). */
export function revokeMarketingConsent(account: Account): Account {
  return { ...account, marketingConsent: null };
}

export function consentCoversSources(account: Account): boolean {
  return account.sensitiveConsent !== null && (account.sensitiveConsent.version ?? 1) >= CONSENT_VERSION;
}

// `§23` 별도 동의 문안 (v2 — #60 확대: 외부 소스 수집 명시) — S4·콘솔이 이 문안을 그대로
// 그린다. 처리방침 편입 문안은 docs/policy/privacy-clauses.md (이 이슈의 문서 영향 산출물).
export const SENSITIVE_CONSENT_TEXT =
  "노트에 담긴 민감정보(건강·신념 등)가 AI 추출 처리에 포함될 수 있습니다. 이 처리에 별도로 동의합니다. " +
  "회원님이 직접 연결한 외부 소스(OneNote·Evernote·Google Drive·Dropbox 등)의 노트 내용 수집·처리도 " +
  "이 동의의 범위에 포함됩니다. 동의 전에는 어떤 추출 처리도 시작되지 않으며, 동의는 언제든 철회할 수 있습니다.";

// ---- 소유 경계 (AC9 · 스펙 AC33) — 남의 계정은 403, 처리 0. 모든 입구가 먼저 지난다 ----

export interface BillingAuth {
  /** 인증이 확인한 호출자. */
  authAccountId: string;
  /** 경로의 자원 소유자. */
  accountId: string;
}

function assertAccountOwner({ authAccountId, accountId }: BillingAuth): void {
  if (authAccountId !== accountId) {
    throw new BillingError(403, ["남의 계정입니다 — 구독·처리·금고 호출은 소유자뿐입니다"]);
  }
}

// ---- Polar MoR 외부 체크아웃 (AC1 · 스펙 AC37) ----

/** 가격 앵커 — 앵커일 뿐이다: 확정은 공개 직전 별건 (비범위). */
export const PRICE_ANCHOR_USD = { min: 14, max: 20 } as const;

// 카드 필드가 없다 — 결제 입력은 Polar 호스티드 페이지의 몫이고 우리는 URL 만 넘긴다.
export interface CheckoutSession {
  accountId: string;
  url: string;
}

// 어댑터(Polar SDK)가 만든 체크아웃 URL 을 검문한다 — Polar 호스티드 https 밖은 전부 거부:
// 카드 정보가 우리 표면을 지나는 경로를 여기서 막는다.
export function externalCheckout(auth: BillingAuth, polarUrl: string): CheckoutSession {
  assertAccountOwner(auth);
  let url: URL;
  try {
    url = new URL(polarUrl);
  } catch {
    throw new BillingError(422, [`체크아웃 URL 이 아닙니다: ${polarUrl}`]);
  }
  const polarHosted =
    url.protocol === "https:" && (url.hostname === "polar.sh" || url.hostname.endsWith(".polar.sh"));
  if (!polarHosted) {
    throw new BillingError(422, [
      "외부 체크아웃은 Polar 호스티드(https)뿐입니다 — 카드 정보가 우리 표면을 지나지 않습니다",
    ]);
  }
  return { accountId: auth.accountId, url: polarUrl };
}

// ---- 구독 상태 — Polar 웹훅이 유일한 입력이다 (AC8·AC10) ----

export type SubscriptionStatus = "active" | "past_due" | "canceled";

export interface Subscription {
  accountId: string;
  /** Polar 쪽 구독 id — 상태 출처의 추적 자리. */
  polarId: string;
  status: SubscriptionStatus;
  updatedAt: string;
  /**
   * 어느 요금제인가 (#130). ⚠️ **선택 필드인 것이 과거 때문이 아니다** — 웹훅이 상품 id 를
   * 요금제로 역매핑하지 못하면(상품 맵 미설정·모르는 상품) 여기가 비고, 그때 쿼터는 **무료
   * 층으로 닫힌다**(`planOfSubscription`). 유료 혜택을 추측해서 주지 않는다는 뜻이다.
   *
   * ⭐ 그래서 이 칸이 비어 있으면 **설정 오류의 신호**다: 돈은 받고 혜택은 무료인 상태이므로
   * 운영자가 알아야 한다. 웹훅 쪽은 모르는 상품을 **시끄럽게** 거부해 그 상태를 만들지 않는다.
   */
  plan?: PlanId;
  /**
   * 다음 주기에 적용될 요금제 (#130) — 다운그레이드가 여기 앉는다. Polar 의 `pending_update`
   * 와 같은 자리이고, 화면이 「다음 결제일부터 X」를 그리는 근거다. 지금 혜택은 `plan` 이 든다.
   */
  pendingPlan?: PlanId;
  /**
   * 결제 주기 (#132). 없으면 월로 읽는다 — 연 결제가 생기기 전의 레코드가 그 꼴이다.
   * ⚠️ **혜택에는 영향이 없다**: 쿼터·원격 MCP 는 요금제가 들고 주기는 청구 간격일 뿐이다.
   * 화면이 「연 결제 중」을 그리고 변경 판정이 주기를 건너는 경우를 가리는 데 쓴다.
   */
  interval?: BillingInterval;
  /** 다음 주기부터 바뀔 결제 주기 (#132) — 연 → 월 예약이 여기 앉는다. */
  pendingInterval?: BillingInterval;
  /**
   * 기간 말 해지 접수 (ISSUE-432) — 해지는 즉시가 아니라 **지불한 기간의 끝**에 선다: Polar
   * 에 보내는 것이 `cancel_at_period_end` 이므로 로컬도 같은 말을 한다. 상태를 canceled 로
   * 닫는 것은 기간 말의 해지 웹훅이고, 그때까지 혜택·유료 수(`paidTriggerEvent`)는 유료다.
   */
  cancelAtPeriodEnd?: boolean;
  /**
   * 가격판 코호트 (ISSUE-242 AC9 — 제8조⑦) — 구독 **생성** 시의 plans.ts 판이 찍히고, 갱신·
   * 좌석 변경·상태 전이가 바꾸지 않는다: 출시 가격이 그 코호트에 영구라는 약속의 기록이다
   * (워크스페이스 멤버 단가 동일 적용 — #211 Q6). 칸 부재 = 출시 코호트(cohortOf).
   */
  cohort?: string;
}

/** 코호트 읽기 — 옛 레코드(칸 부재)는 출시 코호트다: 추측이 아니라 「그때 판이 지금 판」인 시기의 기록이다. */
export function cohortOf(subscription: Subscription): string {
  return subscription.cohort ?? PLANS_COHORT;
}

/**
 * 이 구독이 지금 주는 요금제 (#130) — ⚠️ **닫힌 기본**이다.
 *
 * 활성이 아니면 무료 층이고(해지·연체는 유료 혜택을 주지 않는다), 활성인데 요금제를 모르면
 * **그래도 무료 층**이다: 역매핑이 실패한 구독에 상위 혜택을 추측해 주면, 설정 오류가
 * 「공짜로 프로」로 굳는다. 반대 방향의 틀림(돈 받고 무료 혜택)은 운영자가 보면 고칠 수 있다.
 */
/** 이 구독의 결제 주기 — 없으면 월이다 (#132: 연 결제 이전 레코드). */
export function intervalOfSubscription(subscription: Subscription | null): BillingInterval {
  return subscription?.interval ?? "month";
}

export function planOfSubscription(subscription: Subscription | null, now?: string): Plan {
  if (subscription === null) return FREE_PLAN;
  // 체납 유예 (ISSUE-242 AC8 · #211 Q3) — 유예 7일은 **서비스 유지**다: now 를 아는 호출자
  // (추출 판정)만 이 길을 지난다. now 없는 호출은 기존 닫힌 기본(비활성 = 무료) 그대로다.
  const graced =
    subscription.status === "active" ||
    (now !== undefined && dunningStageOf(subscription, now) === "grace");
  if (!graced) return FREE_PLAN;
  if (subscription.plan === undefined) return FREE_PLAN;
  return planOf(subscription.plan);
}

// ---- 체납 플로우 (ISSUE-242 AC8 · #211 Q3) — 7일 유예 → 읽기 전용 14일 → 정지 ----
//
// 어느 단계도 **삭제가 없다** — 체납은 처리의 문을 닫을 뿐이고, 데이터·내보내기는 선다.
// 단계의 시계는 past_due 전이 시각(updatedAt — 웹훅 상태 매핑이 찍는다)이다.

export const DUNNING_GRACE_DAYS = 7;
export const DUNNING_READ_ONLY_DAYS = 14;

export type DunningStage = "grace" | "read-only" | "suspended";

export function dunningStageOf(subscription: Subscription | null, now: string): DunningStage | null {
  if (subscription === null || subscription.status !== "past_due") return null;
  const days = (Date.parse(now) - Date.parse(subscription.updatedAt)) / (24 * 60 * 60 * 1000);
  if (days < DUNNING_GRACE_DAYS) return "grace";
  if (days < DUNNING_GRACE_DAYS + DUNNING_READ_ONLY_DAYS) return "read-only";
  return "suspended";
}

/** 단계 고지 (AC8 — 거래 고지라 §50 수신동의와 무관 · #197 경계) — 화면·오류가 같은 자구를 쓴다. */
export const DUNNING_NOTICES: Record<DunningStage, string> = {
  grace:
    "결제가 밀렸습니다 — 7일 안에 결제가 서면 서비스가 그대로 유지됩니다. 유예 중 삭제되는 것은 없습니다.",
  "read-only":
    "결제 유예(7일)가 지났습니다 — 새 추출·수집이 멈추고 읽기와 내보내기만 동작합니다. 결제가 서면 즉시 재개됩니다.",
  suspended:
    "구독이 정지됐습니다 — 처리가 멈춥니다. 데이터는 삭제되지 않으며 내보내기는 계속 동작합니다. 결제가 서면 즉시 재개됩니다.",
};

/** 처리(추출·수집 — 쓰기성)의 문 — 읽기 전용·정지 단계는 402 로 선다. 내보내기는 부르지 않는다. */
export function assertDunningAllowsProcessing(subscription: Subscription | null, now: string): void {
  const stage = dunningStageOf(subscription, now);
  if (stage === "read-only" || stage === "suspended") {
    throw new BillingError(402, [DUNNING_NOTICES[stage]]);
  }
}

// ---- 이관·해지 창 (ISSUE-242 AC7 · #211 Q3) — 자리 제공 해지 후 30일 내보내기 → 닫힘 ----
//
// ⚠️ **자리 제공(hosted) 조직에만** 선다 — 자기 PG 조직의 데이터는 그들의 것이고, Starter
// 무료 층은 기한 없이 서는 바닥(#197)이라 닫히지 않는다. 호출자(조직 라우트)가 hosted 를
// 보고 부른다. 개인 구독 해지도 이 창과 무관하다(무료 층 복귀 — 제8조②).

export const TERMINATION_EXPORT_WINDOW_DAYS = 30;

export type TerminationAccess = "open" | "export-window" | "closed";

export function terminationAccessOf(subscription: Subscription | null, now: string): TerminationAccess {
  if (subscription === null || subscription.status !== "canceled") return "open";
  const days = (Date.parse(now) - Date.parse(subscription.updatedAt)) / (24 * 60 * 60 * 1000);
  return days < TERMINATION_EXPORT_WINDOW_DAYS ? "export-window" : "closed";
}

/** 창 종료 뒤 접근 — 403 하나로 닫힌다 (⛔ AC7: 31일째엔 내보내기 포함 전부). 삭제 집행은 허브 정소 몫. */
export function assertTerminationOpen(subscription: Subscription | null, now: string): void {
  if (terminationAccessOf(subscription, now) === "closed") {
    throw new BillingError(403, [
      `이관 창(해지 후 ${String(TERMINATION_EXPORT_WINDOW_DAYS)}일)이 끝나 접근이 닫혔습니다 — 자리 제공 데이터는 창 종료와 함께 삭제 대상입니다`,
    ]);
  }
}

// 서명 검증 — Polar 는 Standard Webhooks 를 따른다: base64(HMAC-SHA256(secret,
// `${id}.${timestamp}.${payload}`)), 헤더 서명은 "v1,<base64>" 공백 구분 목록.
// 허용 오차 밖 시각도 위조로 친다 — 재전송 공격 차단.
export const WEBHOOK_TOLERANCE_SEC = 300;

export interface WebhookHeaders {
  id: string; // webhook-id
  timestamp: string; // webhook-timestamp (unix 초)
  signature: string; // webhook-signature
}

function webhookSecretBytes(secret: string): Uint8Array {
  return secret.startsWith("whsec_")
    ? new Uint8Array(Buffer.from(secret.slice("whsec_".length), "base64"))
    : new TextEncoder().encode(secret);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function verifyWebhookSignature(
  secret: string,
  headers: WebhookHeaders,
  payload: string,
  now: string,
): Promise<boolean> {
  const ts = Number(headers.timestamp);
  if (!Number.isFinite(ts)) return false;
  const nowSec = Math.floor(Date.parse(now) / 1000);
  if (Math.abs(nowSec - ts) > WEBHOOK_TOLERANCE_SEC) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    webhookSecretBytes(secret) as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${headers.id}.${headers.timestamp}.${payload}`) as BufferSource,
  );
  const expected = Buffer.from(new Uint8Array(mac)).toString("base64");
  return headers.signature.split(" ").some((part) => {
    const [version, sig] = part.split(",");
    return version === "v1" && sig !== undefined && timingSafeEqual(sig, expected);
  });
}

// 닫힌 상태 매핑 — 구독 생성·갱신(결제 실패 = past_due 갱신)·해지만 상태에 닿는다.
// 매핑 밖 상태·유형(주문·혜택 등)은 무연산이다 — 모르는 것을 임의로 해석하지 않는다.
const SUBSCRIPTION_STATUS: Record<string, SubscriptionStatus> = {
  active: "active",
  past_due: "past_due",
  canceled: "canceled",
};

export interface PolarEvent {
  type: string;
  /** accountId 는 체크아웃 metadata 로 실어 보내고 웹훅이 되돌려 받는 계약이다. */
  data: {
    id: string;
    /** ⭐ Polar 가 체크아웃 metadata 를 되돌려 주는 자리 — 실물 확인 (아래 `accountIdOf`). */
    metadata?: Record<string, unknown>;
    status?: string;
    /** 결제 주기 (#132) — `"month"` · `"year"`. 실물 확인 2026-11-03. */
    recurring_interval?: string;
    /** 요금제 역매핑의 입력 (#130) — 평평한 쪽과 중첩된 쪽을 둘 다 받는다. */
    product_id?: string;
    /** ⭐ `metadata` 가 **우리 상품인가**의 표식이다 — 아래 `isOurProduct` 주석 참조. */
    product?: { id?: string; metadata?: Record<string, unknown> };
    /** 실전이 시각 (ISSUE-432) — 순서 가드와 `updatedAt` 의 근거. 없으면 전달 시각으로 읽는다. */
    modified_at?: string | null;
    created_at?: string;
    /** 기간 말 해지 표식 (ISSUE-432) — 우리 해지 PATCH 의 에코가 참으로 실어 온다. */
    cancel_at_period_end?: boolean;
  };
}

/**
 * 이벤트가 말하는 실전이 시각 (ISSUE-432) — `updatedAt` 에 **전달 시각(now)이 아니라 이
 * 시각**을 찍는다: 장부 TTL 밖의 중복 전달이 레코드를 다시 스탬프하면 체납 유예·해지 30일
 * 이관 창의 시계가 민다. 시각이 안 실린 이벤트만 전달 시각으로 폴백한다(과거 동작 그대로).
 */
function eventTimeOf(data: PolarEvent["data"], now: string): string {
  const at = data.modified_at ?? data.created_at;
  return typeof at === "string" && at.length > 0 ? at : now;
}

/**
 * 계정 id 는 **`data.metadata`** 에서 읽는다 — ⭐ **실물로 확정했다 (2026-11-03).**
 *
 * 어댑터는 체크아웃에 `metadata: { accountId }` 로 실어 보내고(`hub/polar.ts`), Polar 는 그
 * metadata 를 구독에 전파해 웹훅 `data.metadata` 로 되돌려 준다.
 *
 * ⚠️ 이 모듈은 처음에 `data.accountId` **평평한 자리**를 읽고 있었다 — 그건 **선재 버그였고,
 * 실결제 첫 건에서야 드러났을 것**이다. 한동안 둘 다 읽어 두었는데(「당길 조건: 실제 경로를
 * 확인하면 좁힌다」), 그 조건이 실물로 충족됐다:
 *
 *   같은 조직의 다른 제품이 받은 **구독 이벤트 38건 전수 조사**
 *     · `data.accountId`(평평)  …… **0건**   ← 그 경로는 존재한 적이 없다
 *     · `data.metadata`         …… 38건 (그 제품의 체크아웃 키 `uid` 가 실려 있었다)
 *
 * ⇒ 평평한 읽기를 걷는다. 남겨 두면 **없는 경로를 지키는 코드**가 되고, 다음 사람이
 *   「두 꼴이 다 있나 보다」로 읽는다.
 */
function accountIdOf(data: PolarEvent["data"]): string | null {
  const id = data.metadata?.accountId;
  return typeof id === "string" && id.length > 0 ? id : null;
}

/**
 * 결제 주기를 **웹훅이 되찾는다** (#132) — `data.recurring_interval` 에 실린다(실물 확인:
 * 38건 전부 `"year"`).
 *
 * ⚠️ **이걸 읽지 않으면 연 결제 회원이 월 결제로 보인다** — `intervalOfSubscription` 이
 * 없을 때 월로 떨어지기 때문이다. 혜택은 요금제가 들어 영향이 없지만, 화면이 틀린 말을 하고
 * 「다음 결제일」 계산의 전제가 어긋난다.
 */
function intervalOf(data: PolarEvent["data"]): BillingInterval | undefined {
  return data.recurring_interval === "year" ? "year" : data.recurring_interval === "month" ? "month" : undefined;
}

/** 상품 id 도 두 자리를 본다 — 평평한 `product_id` 와 중첩된 `product.id`. */
function productIdOf(data: PolarEvent["data"]): string | null {
  if (typeof data.product_id === "string" && data.product_id.length > 0) return data.product_id;
  const nested = data.product?.id;
  return typeof nested === "string" && nested.length > 0 ? nested : null;
}

/**
 * Polar 상품 id → 우리 요금제 (#130). 어댑터 설정의 역방향 맵이다.
 *
 * ⛔ **모르는 상품은 시끄럽게 거부한다.** 조용히 넘기면 두 길로 틀린다: 요금제 없이 활성으로
 * 저장하면(돈 받고 무료 혜택) 사용자가 손해를 보고, 아무 층으로 추측하면 공짜로 상위 혜택이
 * 간다. 거부하면 Polar 가 재시도하고 운영자가 맵을 고칠 창이 생긴다 — 「반쯤 된 상태를
 * 조용히 성공으로 포장하지 않는다」(`withdrawAccount`·`firebase-admin.ts` 와 같은 규율).
 */
/**
 * ⭐ **우리 상품인가** — 상품 자신이 든 표식으로 판정한다 (#130, Henry 2026-11-03).
 *
 * 카탈로그 생성이 상품 `metadata` 에 `{ plan }` 을 박는다(`hub/polar-catalog.ts`). 남의
 * 제품 상품에는 그 키가 없다 — **실측으로 확인했다**: 같은 조직의 다른 제품 상품은
 * `metadata` 가 `{}` 였다(구독 이벤트 38건 전부 `data.product.metadata` 를 싣는다).
 *
 * ⚠️ 이것은 **보안 경계가 아니라 소유 표식**이다. 대시보드에서 손으로 바뀔 수 있으므로
 * 권한 판정에 쓰지 않는다 — 진위는 웹훅 서명이 이미 지고, 요금제의 정본은 env 상품 맵이다.
 * 여기서 하는 일은 「이 이벤트를 우리가 처리할 대상인가」라는 **라우팅**뿐이다.
 */
/** 우리 제품의 표식값 — 카탈로그 생성이 상품 metadata 에 박는다 (`hub/polar-catalog.ts`). */
export const PRODUCT_APP_MARKER = "ontoflow";

function isOurProduct(data: PolarEvent["data"]): boolean {
  const meta = data.product?.metadata;
  // ⭐ **선언을 먼저 본다.** `app` 은 「이 상품은 누구 것인가」를 상품이 **직접 말하는** 값이라,
  //    형제 제품도 같은 키로 자기를 선언하면 세 핸들러가 대칭이 된다(추론 0).
  if (meta?.app === PRODUCT_APP_MARKER) return true;
  // ⚠️ 폴백 — `app` 이 생기기 전(또는 대시보드에서 지워진) 상품을 위해 `plan` 의 존재도 받는다.
  //    남의 제품이 우연히 `plan` 키를 쓸 수 있으므로 **선언이 있으면 그쪽이 이긴다**:
  //    `app` 이 **다른 값**이면 남의 것이라고 단정한다.
  if (typeof meta?.app === "string" && meta.app.length > 0) return false;
  return typeof meta?.plan === "string" && meta.plan.length > 0;
}

/**
 * 이벤트의 소속 — 셋갈래다. ⭐ **둘이 아니라 셋인 것이 요점**이다: 「맵에 없다」를 전부
 * 남의 것으로 접으면 **우리 상품인데 env 가 미배선인 경우**(진짜 설정 오류)가 조용해진다.
 *
 *   · `ours`    상품 id 가 우리 맵에 있다 → 정상 처리
 *   · `unwired` 맵엔 없는데 **상품이 우리 표식을 들고 있다** → 설정 오류, 시끄럽게 (`planOfProduct`)
 *   · `foreign` 둘 다 아니다 → 남의 제품, 조용히
 *
 * ⚠️ 맵이 비어 있으면(단일 상품 시절·테스트) 판정할 근거가 없으므로 `ours` 로 둔다 —
 *    그 세계에는 섞일 남의 이벤트가 애초에 없다.
 */
function classify(
  data: PolarEvent["data"],
  products: Readonly<Record<string, PlanId>>,
): "ours" | "unwired" | "foreign" {
  if (Object.keys(products).length === 0) return "ours";
  const productId = productIdOf(data);
  if (productId !== null && products[productId] !== undefined) return "ours";
  return isOurProduct(data) ? "unwired" : "foreign";
}

export function planOfProduct(products: Readonly<Record<string, PlanId>>, productId: string | null): PlanId | null {
  if (productId === null) return null; // 상품을 말하지 않는 이벤트(해지 등) — 요금제를 묻지 않는다
  const plan = products[productId];
  if (plan === undefined) {
    throw new BillingError(422, [
      `모르는 Polar 상품입니다: ${productId} — 요금제 상품 맵(HUB_POLAR_PRODUCT_*)을 확인해 주세요`,
    ]);
  }
  return plan;
}

/**
 * 웹훅 처리 결과. `foreign` 은 **우리 조직의 다른 제품** 이벤트라는 뜻이다 (#130) —
 * 실패가 아니라 「우리 것이 아니다」이므로 호출자는 200 으로 받고 로그만 남긴다.
 */
export interface WebhookOutcome {
  applied: boolean;
  subscription: Subscription | null;
  foreign?: boolean;
  /** 적용 전의 기존 레코드 (ISSUE-432) — 서버의 전이 판정(퍼널 유료 분자)이 재조회 없이 쓴다. */
  previous?: Subscription | null;
}

export function applySubscriptionEvent(
  current: Subscription | null,
  event: PolarEvent,
  now: string,
  /** 요금제 역매핑 (#130) — 미설정(빈 맵)이면 요금제를 묻지 않는다: 단일 상품 시절과 같다. */
  products: Readonly<Record<string, PlanId>> = {},
): WebhookOutcome {
  if (!event.type.startsWith("subscription.")) return { applied: false, subscription: current };
  const data = (event.data ?? {}) as PolarEvent["data"];
  const id = data.id;
  const accountId = accountIdOf(data);

  // ---- ⭐ 「우리 것인가」를 **먼저** 묻는다 (#130, 2026-11-03 보강) ----
  //
  // ⚠️ Polar 웹훅은 **조직 단위**로 퍼진다 — 끝점이 거르는 축은 이벤트 **종류**뿐이고
  // 상품별 필터가 없다(실측: 끝점 스키마에 product 필드가 없고, 한 조직의 다른 끝점이 남의
  // 상품 이벤트 110건을 실제로 받고 있었다). 조직을 공유하면 **남의 구독 이벤트가 들어온다.**
  //
  // 가르는 축은 **상품**이다 — 「우리 체크아웃인가」가 아니라 「우리가 파는 물건인가」가
  // 진짜 질문이기 때문이다(`isOurProduct`). 그 셋갈래가 아래 `classify` 다.
  const belongs = classify(data, products);
  if (belongs === "foreign") {
    // 남의 제품 — 던지면 Polar 가 남의 이벤트에 무한 재시도를 건다.
    return { applied: false, subscription: current, foreign: true };
  }
  if (typeof id !== "string" || id.length === 0 || accountId === null) {
    throw new BillingError(422, [
      "웹훅 데이터에 구독 id·계정 id 가 없습니다 — 체크아웃 metadata 왕복이 계약입니다",
    ]);
  }
  // ---- 순서·동일성 가드 (ISSUE-432) — 웹훅은 순서를 약속하지 않는다 ----
  //
  // 해지 후 재구독에서 구 구독의 canceled 가 새 구독 active **뒤에** 도착하면, 가드 없는
  // 덮어쓰기는 결제 중인 사용자를 무료로 떨어뜨리고 `paidTriggerEvent` 가 유료 0 을 오보한다
  // (서빙 복귀 시계 오발). 축은 둘이다 — ⑴ **동일성**: 다른 `polarId` 의 이벤트는 이 레코드의
  // 과거가 아니라 남이다 ⑵ **시각**: 같은 구독의 과거 이벤트(재전달 포함)는 레코드를 되돌리지
  // 않는다. 같은 시각(같은 이벤트의 재전달)은 적용돼도 동일 레코드라 멱등이다.
  const evAt = eventTimeOf(data, now);
  const sameSub = current !== null && current.polarId === id;
  if (sameSub && Date.parse(evAt) < Date.parse(current.updatedAt)) {
    return { applied: false, subscription: current };
  }
  if (event.type === "subscription.canceled" || event.type === "subscription.revoked") {
    if (current !== null && !sameSub) {
      // 다른 구독의 해지 — 재구독 역순 전달의 전형이다: 죽은 구독이 산 레코드를 밀어내지 못한다.
      return { applied: false, subscription: current };
    }
    // 해지는 요금제를 묻지 않는다 — 혜택이 무료 층으로 떨어지는 것이 상태가 말하는 전부다.
    // 요금제·주기·코호트는 보존한다: 「무엇을 해지했나」가 기록으로 남는다 (보류·해지 표식은 닫힌 일이라 걷는다).
    const kept = !sameSub
      ? {}
      : {
          ...(current.plan === undefined ? {} : { plan: current.plan }),
          ...(current.interval === undefined ? {} : { interval: current.interval }),
          ...(current.cohort === undefined ? {} : { cohort: current.cohort }),
        };
    return { applied: true, subscription: { accountId, polarId: id, status: "canceled", updatedAt: evAt, ...kept } };
  }
  const status = SUBSCRIPTION_STATUS[data.status ?? ""];
  if (status === undefined) return { applied: false, subscription: current };
  if (current !== null && !sameSub) {
    // 다른 polarId 가 레코드를 차지하는 길은 **더 새로운 활성**뿐이다 (재구독의 새 구독).
    // 구 구독 이벤트의 재전달은 — 활성이었더라도 — 지금 레코드보다 과거라 여기서 걸러진다.
    if (status !== "active" || Date.parse(evAt) <= Date.parse(current.updatedAt)) {
      return { applied: false, subscription: current };
    }
  }
  // 상속은 **같은 구독**에만 선다 (ISSUE-432) — 상품 정보 없는 갱신 이벤트가 요금제·주기를
  // 잃지 않되, 재구독(새 polarId)이 옛 구독의 판을 물려받지는 않는다: 새 구독은 지금 카탈로그로
  // 산 것이다 (제8조⑦ 의 코호트 약속은 「그 구독」에 선다).
  const inherited = sameSub ? current : null;
  // 맵이 비어 있으면 요금제 칸을 비운다 — `planOfSubscription` 이 그것을 무료 층으로 닫는다.
  const plan =
    Object.keys(products).length === 0 ? undefined : (planOfProduct(products, productIdOf(data)) ?? inherited?.plan);
  const interval = intervalOf(data) ?? inherited?.interval;
  // ⭐ 보류(pendingPlan/Interval)는 **예약의 기록**이다 (ISSUE-432) — 치우는 것은 요금제·주기가
  //    **실제로 바뀐** 이벤트뿐이다: Polar 가 `next_period` 변경을 적용하면 새 값이 실려 오고,
  //    그때 「다음 주기」가 「지금」이 된 것이다. 그 밖의 웹훅(갱신·상태 전이)은 예약을 보존한다.
  const pendingKept =
    inherited !== null &&
    (plan ?? null) === (inherited.plan ?? null) &&
    (interval ?? "month") === (inherited.interval ?? "month")
      ? {
          ...(inherited.pendingPlan === undefined ? {} : { pendingPlan: inherited.pendingPlan }),
          ...(inherited.pendingInterval === undefined ? {} : { pendingInterval: inherited.pendingInterval }),
        }
      : {};
  // 기간 말 해지 표식 — 에코가 명시하면 그 말이 정본이고(참·거짓 모두), 말하지 않으면 보존한다.
  const cancelAtPeriodEnd =
    data.cancel_at_period_end ?? (inherited?.cancelAtPeriodEnd === true ? true : undefined);
  return {
    applied: true,
    subscription: {
      accountId,
      polarId: id,
      status,
      updatedAt: evAt,
      // 코호트 (ISSUE-242 AC9 — 제8조⑦): 생성 시의 가격판이 찍히고 같은 구독의 갱신이 보존한다
      // — 상태·요금제가 바뀌어도 「언제 산 구독인가」는 바뀌지 않는다. ⚠️ ISSUE-432 전엔 이
      // 보존이 죽은 코드였다(웹훅이 current=null 로 불렀다): 가격 개정 뒤 갱신 한 번에 코호트가
      // 새 판으로 덮이는 제8조⑦ 위반 경로였다.
      cohort: inherited?.cohort ?? PLANS_COHORT,
      ...(plan === undefined ? {} : { plan }),
      ...(interval === undefined ? {} : { interval }),
      ...pendingKept,
      ...(cancelAtPeriodEnd === true ? { cancelAtPeriodEnd: true } : {}),
    },
  };
}

// API5 웹훅 입구 — 서명이 맞지 않으면 상태 변경 0 으로 선다 (AC10). 검증을 지나야만
// 본문이 해석된다: 위조 본문이 상태에 닿는 경로가 없다.
async function verifiedWebhookEvent(
  secret: string,
  headers: WebhookHeaders,
  payload: string,
  now: string,
): Promise<PolarEvent> {
  if (!(await verifyWebhookSignature(secret, headers, payload, now))) {
    throw new BillingError(401, ["웹훅 서명이 맞지 않습니다 — 위조로 보고 상태 변경 0"]);
  }
  let doc: unknown;
  try {
    doc = JSON.parse(payload);
  } catch (e) {
    throw new BillingError(422, [`웹훅 본문이 JSON 이 아닙니다: ${(e as Error).message}`]);
  }
  if (typeof doc !== "object" || doc === null || typeof (doc as { type?: unknown }).type !== "string") {
    throw new BillingError(422, ["웹훅 본문에 type 이 없습니다"]);
  }
  return doc as unknown as PolarEvent;
}

export async function handlePolarWebhook(
  secret: string,
  headers: WebhookHeaders,
  payload: string,
  /**
   * 기존 구독 조회 (ISSUE-432) — 호출자가 저장소 읽기를 잇는다. ⚠️ **null 상수가 아니라
   * 조회를 받는 것이 이 자리의 계약이다**: 웹훅이 current=null 로 부르던 동안
   * `applySubscriptionEvent` 의 보존(코호트·요금제 폴백·보류)과 가드가 전부 죽은 코드였다.
   */
  lookup: (accountId: string) => Promise<Subscription | null>,
  now: string,
  /** 요금제 역매핑 (#130) — 상품 맵. 빈 맵이면 요금제를 묻지 않는다. */
  products: Readonly<Record<string, PlanId>> = {},
): Promise<WebhookOutcome> {
  const event = await verifiedWebhookEvent(secret, headers, payload, now);
  // 조회는 구독 축에만 — 서명을 지난 본문의 accountId 로만 저장소에 닿는다 (위조 조회 0).
  const accountId = event.type.startsWith("subscription.")
    ? accountIdOf((event.data ?? {}) as PolarEvent["data"])
    : null;
  const current = accountId === null ? null : await lookup(accountId);
  return { ...applySubscriptionEvent(current, event, now, products), previous: current };
}

// ---- 팩 구매·환불의 Polar 왕복 (#193 B4 · ISSUE-233 AC7·AC8) ----
//
// 팩은 **구독이 아니라 일회성 주문**이다(제8조⑦ 코호트 밖) — Polar 축으로는 `order.*` 이벤트.
// 체크아웃 metadata 의 accountId 왕복 계약은 구독과 같고, 「우리 팩인가」는 상품 metadata 의
// `{ app, pack }` 표식으로 가린다(카탈로그 CLI 가 박는다 — 구독 상품의 `{ app, plan }` 과 같은 결).

/** 팩 상품의 표식값 — 카탈로그 생성이 상품 metadata `pack` 에 박는다. */
export const PACK_PRODUCT_MARKER = "credit-pack";

export interface PackWebhookOutcome {
  applied: boolean;
  ownerId?: string;
  /** `order.created` — 결제가 선 주문이 팩 하나로 적재된다 (id = Polar 주문 id). */
  pack?: CreditPack;
  /** `order.refunded` — 환불된 주문의 팩을 회수한다. */
  refundedPackId?: string;
}

export function applyPackOrderEvent(event: PolarEvent, now: string): PackWebhookOutcome {
  if (!event.type.startsWith("order.")) return { applied: false };
  const data = (event.data ?? {}) as PolarEvent["data"];
  const meta = data.product?.metadata;
  // ⚠️ 구독 상품의 주문 이벤트도 여기로 온다(Polar 는 구독 청구도 order 를 낸다) — 팩 표식이
  //    없으면 전부 무시한다: 구독 축은 subscription.* 핸들러가 들고, 남의 제품도 여기서 걸러진다.
  if (meta?.app !== PRODUCT_APP_MARKER || meta.pack !== PACK_PRODUCT_MARKER) return { applied: false };
  const id = data.id;
  const ownerId = accountIdOf(data);
  if (typeof id !== "string" || id.length === 0 || ownerId === null) {
    throw new BillingError(422, ["팩 주문 웹훅에 주문 id·계정 id 가 없습니다 — 체크아웃 metadata 왕복이 계약입니다"]);
  }
  if (event.type === "order.refunded") return { applied: true, ownerId, refundedPackId: id };
  if (event.type === "order.created") return { applied: true, ownerId, pack: newCreditPack(id, now) };
  return { applied: false }; // order.updated 등 — 적재·회수 둘 다 아니다
}

export async function handlePolarPackWebhook(
  secret: string,
  headers: WebhookHeaders,
  payload: string,
  now: string,
): Promise<PackWebhookOutcome> {
  return applyPackOrderEvent(await verifiedWebhookEvent(secret, headers, payload, now), now);
}

/**
 * 환불 판정 (AC7·AC8) — 7일 안 · 미사용 전액뿐이다. 거부는 이유가 다른 두 문장으로 선다:
 * UI 는 `ConsoleView.packs[].refundable` 로 진입점 자체를 가리고, 이 판정은 그 뒤의 집행이다.
 * 실제 환불은 Polar 가 지고(어댑터), 이 판정의 통과가 그 호출의 전제다 — 순서는 판정 → Polar → 저장.
 */
export function requestPackRefund(
  auth: BillingAuth,
  packs: readonly CreditPack[],
  packId: string,
  now: string,
): CreditPack {
  assertAccountOwner(auth);
  const pack = packs.find((p) => p.id === packId);
  if (pack === undefined) throw new BillingError(404, ["그 팩이 없습니다"]);
  if (!packRefundable(pack, now)) {
    throw new BillingError(422, [
      pack.remaining < pack.credits
        ? "이미 사용한 팩은 환불할 수 없습니다 — 환불은 미사용 전액뿐입니다"
        : `환불 창(구매 후 ${CREDIT_PACK.refundDays}일)이 지났습니다`,
    ]);
  }
  return pack;
}

// ---- 해지 같은 도구 (AC2 · 공정위 고시 2025-8호) — 가입한 콘솔(S3) 안의 한 호출로
// 완결된다: 입력에 이메일·전화 같은 추가 채널이 아예 없다. Polar 쪽 해지 API 는 어댑터가
// 잇고, 이 판정의 반환이 곧 해지 접수 완결이다 ----

export function cancelSubscription(
  auth: BillingAuth,
  subscription: Subscription | null,
  now: string,
): Subscription {
  assertAccountOwner(auth);
  if (subscription === null) throw new BillingError(404, ["해지할 구독이 없습니다"]);
  // 기간 말 해지 (ISSUE-432) — Polar 엔 `cancel_at_period_end` 를 보내면서 로컬만 즉시
  // canceled 로 꺾으면 넷이 틀린다: 지불한 잔여 기간의 유료 혜택 상실 · hosted 30일 이관 창
  // 조기 개시 · Polar 의 updated(active) 에코와 상태 왕복 · paid-zero 서빙 신호 조기 발화.
  // 상태를 canceled 로 닫는 것은 **기간 말의 해지 웹훅**이고, 여기는 접수 표식만 선다.
  if (subscription.cancelAtPeriodEnd === true) return subscription; // 재접수 — 시계 재스탬프 0
  return { ...subscription, cancelAtPeriodEnd: true, updatedAt: now };
}

// ---- 증액·무료→유료 전환 (AC3 · `§13`⑥) — 30일 전 동의 없이 시행되지 않는다 ----

export const PLAN_CHANGE_NOTICE_DAYS = 30;

export interface PlanChange {
  kind: "increase" | "free-to-paid";
  effectiveAt: string;
  /** 사전 동의 — null 이면 시행 자체가 없다. */
  consent: { grantedAt: string } | null;
}

export function assertPlanChangeEnforceable(change: PlanChange, now: string): void {
  const problems: string[] = [];
  if (change.consent === null) {
    problems.push("사전 동의가 없습니다 — 30일 전 동의 없이 시행되지 않습니다 (`§13`⑥)");
  } else {
    const noticeMs = PLAN_CHANGE_NOTICE_DAYS * 24 * 60 * 60 * 1000;
    if (Date.parse(change.effectiveAt) - Date.parse(change.consent.grantedAt) < noticeMs) {
      problems.push(`동의가 시행일 ${PLAN_CHANGE_NOTICE_DAYS}일 전을 지나 받혔습니다 — 시행일을 미룹니다`);
    }
  }
  if (Date.parse(now) < Date.parse(change.effectiveAt)) {
    problems.push("아직 시행일 전입니다");
  }
  if (problems.length > 0) throw new BillingError(403, problems);
}

// ---- 크레딧 지갑 (#193·#197 · ISSUE-233) — 월 지급분 + 팩, 소비처는 추출뿐 ----

// ⭐ 값은 `plans.ts` 의 무료 칸에서 온다 — 가격·크레딧의 단일 소스다.
export const FREE_MONTHLY_CREDITS = FREE_CREDITS;

// 집계 — 소비 수·시점·노트 식별자(경로)만 남는다 (AC6 · 스펙 AC42): 노트 내용·제목이 들어올
// 필드 자체가 없다. ⚠️ chargedNotes 의 키는 vault 상대 경로다 — 「같은 달 같은 노트 재추출
// 무소비」(#193 최신 유지권)의 장부라 경로가 필요하고, 월이 바뀌면 통째로 비워진다.
export interface UsageRecord {
  accountId: string;
  /** 월 지갑의 달 — "YYYY-MM". 달이 바뀌면 지급분·장부가 0 에서 다시 선다 (팩은 보존). */
  period: string;
  /** 이 달에 월 지급분에서 소비한 크레딧. */
  credits: number;
  /** 이 달에 과금된 노트 → 크레딧 — 같은 달 재추출은 여기 있으면 0 이다. */
  chargedNotes: Record<string, number>;
  lastAt: string | null;
  /** 최초 전체 색인 완주 시각 — 사용자 데이터베이스당 영구 1회 (AC7 · 소비 0). */
  initialIndexAt: string | null;
  /** 워크스페이스 지갑 전용 — 멤버별 최초 색인 (사람×워크스페이스 영구 1회, #193). */
  initialIndexBy?: Record<string, string>;
  /**
   * 사용량 고지 장부 (AC12 — 80% 알림 · 100% 거래 고지) — 보낸 시각. ⭐ **주기 귀속**이다:
   * 달이 바뀌면 지갑과 함께 비워져 「같은 주기에 중복 발송되지 않는다」가 이 한 자리로 선다.
   */
  notices?: Partial<Record<UsageNoticeKind, string>>;
}

export const monthOf = (now: string): string => now.slice(0, 7);

export function emptyUsage(accountId: string, now: string): UsageRecord {
  return { accountId, period: monthOf(now), credits: 0, chargedNotes: {}, lastAt: null, initialIndexAt: null };
}

// ---- 크레딧 팩 — 일회성 구매 (제8조⑦ 코호트 밖 · 5년 유효 · 7일 미사용 전액 환불) ----

export interface CreditPack {
  id: string;
  purchasedAt: string;
  credits: number;
  remaining: number;
  expiresAt: string;
}

export function newCreditPack(id: string, now: string): CreditPack {
  const expires = new Date(Date.parse(now));
  expires.setUTCFullYear(expires.getUTCFullYear() + CREDIT_PACK.validYears);
  return { id, purchasedAt: now, credits: CREDIT_PACK.credits, remaining: CREDIT_PACK.credits, expiresAt: expires.toISOString() };
}

export const packLive = (pack: CreditPack, now: string): boolean =>
  pack.remaining > 0 && Date.parse(now) < Date.parse(pack.expiresAt);

export function packsBalance(packs: readonly CreditPack[], now: string): number {
  return packs.filter((p) => packLive(p, now)).reduce((sum, p) => sum + p.remaining, 0);
}

/** 환불 가능 — 7일 안 + 미사용 전액뿐이다 (#193 B4). 부분 사용은 어떤 창에서도 불가다. */
export function packRefundable(pack: CreditPack, now: string): boolean {
  const ageDays = (Date.parse(now) - Date.parse(pack.purchasedAt)) / (24 * 60 * 60 * 1000);
  return ageDays <= CREDIT_PACK.refundDays && pack.remaining === pack.credits;
}

/** 소비 — 월 지급분 먼저, 팩은 오래된 것부터. 호출 전에 잔량 검사를 끝낸 자리다. */
function consumePacks(packs: readonly CreditPack[], amount: number, now: string): CreditPack[] {
  let left = amount;
  return [...packs]
    .sort((a, b) => a.purchasedAt.localeCompare(b.purchasedAt))
    .map((p) => {
      if (left === 0 || !packLive(p, now)) return p;
      const take = Math.min(p.remaining, left);
      left -= take;
      return { ...p, remaining: p.remaining - take };
    });
}

/**
 * 소비처 셋 (#193·#197 · 약관 제8조③ — 「소비처 = 증분 추출 + 노트 합성」, 최초 색인은 무소비
 * 1회): `synthesis` 는 ISSUE-361 로 합류했다 — 판정 규칙은 incremental 과 동일하게
 * decideCreditSpend 하나를 지난다(같은 달 같은 식별자 무소비·hold·팩·고지 전부 공유).
 */
export type ExtractionKind = "initial-index" | "incremental" | "synthesis";

export interface ExtractionRequest {
  kind: ExtractionKind;
  /**
   * 처리할 노트 — 식별자(경로)와 처리량(자 수)뿐이다: 내용은 이 판정에 닿지 않는다.
   * 합성의 식별자는 `synthesis:<소스id>` 다 — vault·소스 노트 경로(`<id>:/…`)와 꼴이 달라
   * 충돌이 없고, 「그 달 그 소스 재합성 무소비」가 추출의 유지권과 같은 기구로 선다.
   */
  notes: { id: string; chars: number }[];
}

// ---- 사용량 고지 (#193 AC12 — 동반 출고 조건의 알림 축) ----
//
// v1 의 발송 채널은 **API 응답과 콘솔**이다 — 이메일 인프라가 없고(1인 운영 표면), 플러그인이
// 응답의 notices 를 받아 사용자에게 세운다. 「발송 1회」는 채널이 아니라 **장부**(UsageRecord.
// notices — 주기 귀속)가 보장한다: 임계를 처음 지난 그 판정에만 실리고, 같은 주기엔 다시 없다.

export const USAGE_NOTICE_KINDS = ["usage-80", "usage-100"] as const;
export type UsageNoticeKind = (typeof USAGE_NOTICE_KINDS)[number];

/**
 * 임계 스탬프. ⚠️ `usage-100`(거래 고지)의 축은 비율만이 아니다 — **「지갑이 처리를 더 받지
 * 못한 첫 순간」**이다: 정확히 소진(비율 1.0)과 hold(잔량이 요청보다 작음) 중 먼저 오는 쪽.
 * 비율만 재면 29/30 에서 영원히 hold 만 나고 거래 고지가 안 나가는 구멍이 생긴다.
 */
function stampUsageNotices(
  quota: number | null,
  usage: UsageRecord,
  now: string,
  exhausted: boolean,
): { usage: UsageRecord; fired: UsageNoticeKind[] } {
  if (quota === null || quota <= 0) return { usage, fired: [] }; // 무제한 지갑엔 임계가 없다
  const sent = usage.notices ?? {};
  const ratio = usage.credits / quota;
  const fired: UsageNoticeKind[] = [];
  if (ratio >= 0.8 && sent["usage-80"] === undefined) fired.push("usage-80");
  if ((ratio >= 1 || exhausted) && sent["usage-100"] === undefined) fired.push("usage-100");
  if (fired.length === 0) return { usage, fired };
  const notices = { ...sent };
  for (const kind of fired) notices[kind] = now;
  return { usage: { ...usage, notices }, fired };
}

export type ExtractionDecision =
  | { allowed: true; usage: UsageRecord; packs: CreditPack[]; creditsSpent: number; notices: UsageNoticeKind[] }
  /**
   * 거부 — `hold` 가 참이면 실패가 아니라 **대기**다 (#193 AC5): 노트는 보류함에 쌓이고
   * 충전·주기 갱신 뒤 처리된다. 유실이 아니므로 호출자는 재시도 경로(`held`)로 돌린다.
   * ⚠️ hold 에도 `usage` 가 실릴 수 있다 — 고지 장부 스탬프(AC12)다: 호출자는 받은 usage 를
   * **박아야** 같은 주기 중복 발송이 막힌다(소비 수는 변하지 않는다).
   */
  | {
      allowed: false;
      status: number;
      reason: string;
      upgrade: boolean;
      hold?: boolean;
      usage?: UsageRecord;
      notices?: UsageNoticeKind[];
    };

// ---- 공유 판정 엔진 — 개인 지갑과 워크스페이스 풀이 같은 규칙으로 돈다 (지갑 2층 분리:
// 교차 차감은 구조적으로 불가 — 각 경로가 자기 usage·packs 만 받는다) ----

export function decideCreditSpend(
  plan: Plan,
  quota: number | null,
  usage: UsageRecord,
  packs: readonly CreditPack[],
  request: ExtractionRequest,
  now: string,
): ExtractionDecision {
  if (!Array.isArray(request.notes) || request.notes.length === 0) {
    throw new BillingError(422, ["처리할 노트가 없습니다"]);
  }
  for (const note of request.notes) {
    if (typeof note.id !== "string" || note.id.trim().length === 0) {
      throw new BillingError(422, ["노트 식별자가 비어 있습니다"]);
    }
  }
  const period = monthOf(now);
  const current: UsageRecord =
    usage.period === period ? usage : { ...usage, period, credits: 0, chargedNotes: {}, notices: {} };

  if (request.kind === "initial-index") {
    // 최초 색인은 소비 0 · 영구 1회 (AC7·AC10). 재실행(전체 재색인)은 요금제 가용이 든다.
    if (!plan.reindex && current.initialIndexAt !== null) {
      return {
        allowed: false,
        status: 402,
        reason: "최초 전체 색인은 1회입니다 — 재색인은 구독 몫입니다, 업그레이드해 주세요",
        upgrade: true,
      };
    }
    return {
      allowed: true,
      usage: { ...current, initialIndexAt: current.initialIndexAt ?? now, lastAt: now },
      packs: [...packs],
      creditsSpent: 0,
      notices: [], // 소비 0 — 임계가 움직이지 않는다
    };
  }

  const charged = current.chargedNotes ?? {};
  let cost = 0;
  for (const note of request.notes) {
    // 같은 달 같은 노트는 무소비 — 「그 달 그 노트의 최신 유지권」 (#193).
    if ((charged[note.id] ?? 0) > 0) continue;
    cost += creditsForChars(note.chars);
  }
  const monthlyLeft = quota === null ? Number.POSITIVE_INFINITY : Math.max(0, quota - current.credits);
  const packLeft = packsBalance(packs, now);
  if (cost > monthlyLeft + packLeft) {
    // 지갑이 처리를 더 받지 못한 순간 — 거래 고지(usage-100)가 설 자리다 (AC12).
    const stamped = stampUsageNotices(quota, current, now, true);
    return {
      allowed: false,
      status: 402,
      reason:
        quota === null
          ? "크레딧이 부족합니다 — 처리는 대기로 쌓입니다(유실 0), 팩을 충전해 주세요"
          : `${plan.name} 월 ${quota}크레딧 지갑 소진 — 처리는 대기로 쌓이고(유실 0), 팩 충전·업그레이드·주기 갱신 뒤 처리됩니다`,
      upgrade: rankOf(plan.id) < rankOf(plan.seatBased ? "team-pro" : "pro"),
      hold: true, // #193 AC5 — 실패가 아니라 대기다
      usage: stamped.usage,
      notices: stamped.fired,
    };
  }
  const fromMonthly = Math.min(cost, quota === null ? cost : monthlyLeft);
  const fromPacks = cost - fromMonthly;
  const nextCharged = { ...charged };
  for (const note of request.notes) {
    if ((nextCharged[note.id] ?? 0) > 0) continue;
    nextCharged[note.id] = creditsForChars(note.chars);
  }
  const spent: UsageRecord = {
    ...current,
    credits: current.credits + fromMonthly,
    chargedNotes: nextCharged,
    lastAt: now,
  };
  const stamped = stampUsageNotices(quota, spent, now, false);
  return {
    allowed: true,
    usage: stamped.usage,
    packs: consumePacks(packs, fromPacks, now),
    creditsSpent: cost,
    notices: stamped.fired,
  };
}

// 처리 허가 판정 — 동의(AC4) → 지갑 순. 거부는 예외가 아니라 값이다. 반환된 usage·packs 는
// 처리 완료 후에 박는다 — 처리가 실패하면 버려서 지갑이 새지 않는다.
export function decideExtraction(
  auth: BillingAuth,
  account: Account,
  subscription: Subscription | null,
  usage: UsageRecord,
  packs: readonly CreditPack[],
  request: ExtractionRequest,
  now: string,
): ExtractionDecision {
  assertAccountOwner(auth);
  if (account.id !== auth.accountId || usage.accountId !== account.id) {
    throw new BillingError(403, ["계정·집계가 호출자와 어긋납니다 — 처리 0"]);
  }
  if (account.sensitiveConsent === null) {
    return {
      allowed: false,
      status: 403,
      reason: "`§23` 민감정보 별도 동의 전입니다 — 동의가 처리의 선행 조건입니다",
      upgrade: false,
    };
  }
  // 체납 단계 (ISSUE-242 AC8) — 읽기 전용·정지는 처리의 문이 닫힌다(402 + 단계 고지).
  assertDunningAllowsProcessing(subscription, now);
  // ⭐ 「어느 요금제냐」가 축이다 (#130→#193). 개인 지갑 — 워크스페이스 풀은 org.ts 경로다.
  // now 동반 — 체납 유예 7일은 혜택이 유지된다 (AC8 「유예」의 뜻).
  const plan = planOfSubscription(subscription, now);
  return decideCreditSpend(plan, quotaOf(plan), usage, packs, request, now);
}

// ---- 요금제 변경 (#130) — ⚠️ `assertPlanChangeEnforceable` 과 **다른 경로**다 ----
//
// 위쪽 `assertPlanChangeEnforceable` 은 **회사가 올리는** 증액·무료→유료 전환에 붙는 판정이고
// 30일 전 동의를 요구한다(약관 제8조 ⑦ · 제3조 ③). 아래는 **사용자가 스스로 고르는** 변경이다.
// ⭐ 둘을 갈라 둔 이유가 양방향이다: 사용자 변경에 30일 게이트를 걸면 **업그레이드가 영원히
//    불가능**해지고, 회사 인상에서 그 게이트를 빼면 ⑦ 위반이다. 이름이 섞이면 둘 다 일어난다.

/** 변경의 방향과 시점. 다운그레이드는 기간 말이다 — 아래 주석이 그 이유를 든다. */
export interface PlanSwitch {
  from: PlanId;
  to: PlanId;
  /** 결제 주기도 함께 바뀔 수 있다 (#132) — 같은 티어에서 주기만 바꾸는 것도 변경이다. */
  fromInterval: BillingInterval;
  toInterval: BillingInterval;
  direction: "upgrade" | "downgrade";
  /**
   * `immediate` = 지금 바뀐다(차액 즉시 청구) · `next-period` = 다음 주기부터.
   *
   * ⚠️ **다운그레이드를 즉시 적용하지 않는 이유 둘**: ⑴ 이미 지불한 기간의 상위 혜택을 깎는
   * 것은 지불한 것을 빼앗는 것이다 ⑵ 상위 층에서 하위 쿼터를 이미 넘겨 쓴 상태라면 즉시
   * 적용은 그 달을 **곧바로 소진 상태**로 만든다 — 사용자가 산 적 없는 결과다.
   */
  timing: "immediate" | "next-period";
}

/**
 * 사용자가 고른 요금제 변경을 판정한다 (#130) — 순수 함수다. Polar 호출은 어댑터가 든다.
 *
 * 거부가 다섯이고 **전부 이유가 다르다**: 구독 없음(체크아웃으로) · 무료로 내려감(해지로) ·
 * 좌석 축(조직으로) · 같은 요금제(헛호출) · 활성 아님(연체·해지 상태에서 바꾸지 않는다).
 */
/**
 * 두 (요금제, 주기)의 **연 환산 지출**로 방향을 가린다 (#132).
 *
 * ⭐ 티어 등급만 보면 「프로 월 → 스탠다드 연」 같은 조합을 못 가린다. 사용자가 실제로 더
 * 내는가 덜 내는가가 업/다운의 뜻이므로, 연간 총액을 축으로 쓴다 — 그러면 티어 변경과
 * 주기 변경이 **한 자에서** 비교된다.
 * ⚠️ 가격이 없으면(`tbd`) 등급으로 떨어진다 — 그 경우는 `assertSubscribable` 이 이미 막는다.
 */
function annualSpendOf(planId: PlanId, interval: BillingInterval): number {
  const plan = planOf(planId);
  const price = priceUsdOf(plan, interval);
  if (price === null) return rankOf(planId); // 값이 없으면 등급으로 — 어차피 팔리지 않는다
  return interval === "month" ? price * 12 : price;
}

export function decidePlanSwitch(
  auth: BillingAuth,
  subscription: Subscription | null,
  to: string,
  _now: string,
  /** 바꿀 결제 주기 (#132). 생략하면 **지금 주기를 유지**한다 — 티어만 바꾸는 흔한 경우다. */
  toInterval?: BillingInterval,
): PlanSwitch {
  assertAccountOwner(auth);
  if (subscription === null) {
    throw new BillingError(404, ["구독이 없습니다 — 먼저 구독해 주세요(체크아웃)"]);
  }
  if (subscription.accountId !== auth.accountId) {
    throw new BillingError(403, ["남의 구독입니다 — 변경 0"]);
  }
  const target = planOf(to);
  if (target.id === "free") {
    // ⭐ 「무료로 내려가기」는 변경이 아니라 **해지**다. 한 호출로 완결되는 해지 도구가
    //    이미 있으므로(AC2 · 공정위 고시) 거기로 돌려세운다 — 두 경로가 같은 일을 하면
    //    「해지는 했는데 구독이 남은」 상태가 생긴다.
    throw new BillingError(422, ["무료 층으로 내려가는 것은 해지입니다 — 해지를 눌러 주세요 (약관 제8조 ②)"]);
  }
  assertSubscribable(target); // 좌석 축 · 가격 미확정을 여기서 함께 거른다
  if (subscription.status !== "active") {
    throw new BillingError(409, [
      subscription.status === "past_due"
        ? "결제가 밀린 구독입니다 — 결제가 선 뒤에 바꿔 주세요 (밀린 채 올리면 미수금이 늡니다)"
        : "해지된 구독입니다 — 다시 구독해 주세요",
    ]);
  }
  // 기간 말 해지 접수분 (ISSUE-432) — Polar 쪽이 이미 기간 말 해지로 가는 구독이라 변경
  // PATCH 가 그 접수와 충돌한다. 혜택은 기간 말까지 유지되고, 그 뒤 새 구독으로 고르면 된다.
  if (subscription.cancelAtPeriodEnd === true) {
    throw new BillingError(409, ["해지가 접수된 구독입니다 — 남은 기간이 끝나면 닫힙니다. 그 뒤 다시 구독해 주세요."]);
  }
  const from = planOfSubscription(subscription).id;
  const fromInterval = intervalOfSubscription(subscription);
  const nextInterval = toInterval ?? fromInterval;
  if (from === target.id && fromInterval === nextInterval) {
    throw new BillingError(422, [`이미 ${target.name}${fromInterval === "year" ? " 연 결제" : ""}입니다`]);
  }
  // ⭐ 방향은 **연 환산 지출**로 가린다 — 티어와 주기가 한 자에서 비교된다 (#132).
  const direction =
    annualSpendOf(target.id, nextInterval) > annualSpendOf(from, fromInterval) ? "upgrade" : "downgrade";
  return {
    from,
    to: target.id,
    fromInterval,
    toInterval: nextInterval,
    direction,
    timing: direction === "upgrade" ? "immediate" : "next-period",
  };
}

/** 판정을 구독 레코드에 접는다 — 즉시면 `plan`, 다음 주기면 `pendingPlan` 이 바뀐다. */
export function applyPlanSwitch(subscription: Subscription, switched: PlanSwitch, now: string): Subscription {
  return switched.timing === "immediate"
    ? {
        ...subscription,
        plan: switched.to,
        interval: switched.toInterval,
        pendingPlan: undefined,
        pendingInterval: undefined,
        updatedAt: now,
      }
    : {
        ...subscription,
        pendingPlan: switched.to,
        pendingInterval: switched.toInterval,
        updatedAt: now,
      };
}

// ---- 허브 콘솔 S3 (AC2·AC8) — 구독 · 목적지 연결 · 위탁 목록 · 해지, 한 화면 ----

// 위탁 목록 — 처리방침 `§26`② 공개 문안의 화면 정본 (S3 가 그대로 그린다).
// 콘텐츠 처리 리전 = AWS 서울(`§28-8` 비발화) · 인증 계정 정보만 Google 국외 처리
// (#37 — 고지 한정 발화). 확장 조건은 docs/policy/privacy-clauses.md 에 적혀 있다.
// 외부 소스 제공자(Microsoft·Evernote·Google Drive·Dropbox)는 이 목록에 없다 — 수탁자가
// 아니라는 판정(#60): 사용자가 자기 계정의 데이터를 읽어오도록 지시하는 상대방이지, 우리가
// 처리를 위탁하는 곳이 아니다. 고지는 `§23` 확대 문안(수집 명시)이 진다 — privacy-clauses.md.
export const PROCESSORS = [
  { name: "Polar", role: "결제 (Merchant of Record)" },
  { name: "AWS", role: "AI 처리 인프라", region: "서울 (ap-northeast-2)" },
  { name: "Google", role: "회원 인증 (Firebase Authentication)", scope: "인증 계정 정보 한정 — 국외 처리" },
] as const;

export interface ConsoleView {
  accountId: string;
  subscription: {
    status: SubscriptionStatus | "free";
    updatedAt: string | null;
    /** 기간 말 해지 접수 (ISSUE-432) — 활성인데 참이면 화면은 「해지 예정」을 그린다. */
    cancelAtPeriodEnd: boolean;
  };
  /** 금고의 목적지 연결 — 연결 사실만 든다: 비밀값은 콘솔에 오지 않는다. */
  destinations: Destination[];
  processors: typeof PROCESSORS;
  /** 해지가 가입한 같은 도구 안에 선다 (AC2) — 추가 채널 요구 0. */
  actions: ("구독" | "해지" | "요금제 변경")[];
  /** 지금 주는 요금제의 식별자 (#130) — 이름·가격은 `GET /v1/plans` 카탈로그가 든다. */
  plan: PlanId;
  /** 다음 주기에 적용될 요금제 (#130) — 다운그레이드 예약. 없으면 null. */
  pendingPlan: PlanId | null;
  /** 결제 주기 (#132) — 화면이 「연 결제 중」을 그린다. */
  interval: BillingInterval;
  /** 다음 주기부터 바뀔 결제 주기 (#132). 없으면 null. */
  pendingInterval: BillingInterval | null;
  /**
   * 쿼터 현황 — ⚠️ 이름이 `freeTier` 인 것은 **과거다**(#130 전에는 무료 층에만 쿼터가
   * 있었다). 지금 기준은 「쿼터가 유한한가」이므로 하위 유료 층도 이 칸을 받는다. 무제한
   * 요금제면 null 이고 화면이 막대를 그리지 않는다.
   */
  freeTier: { monthlyCredits: number; used: number; initialIndexUsed: boolean } | null;
  /**
   * 사용량 — 쿼터와 별개 축이다: 쿼터는 유한한 요금제에만 있고(freeTier), 사용량은 전 층이
   * 본다. 실린 것은 집계 레코드 그대로 건수·시점뿐이다 — 노트 제목·경로가 들어올 필드가
   * 없다 (스펙 AC42).
   */
  usage: { period: string; credits: number; lastAt: string | null };
  /**
   * 팩 잔량 (#193 — 사용량 대시보드의 둘째 칸). 월 지갑과 **별도 축**이다: 주기 리셋 밖에서
   * 보존되고(위로만 쌓기), 만료·소진분은 집계에서 이미 빠져 있다.
   */
  packsBalance: number;
  /**
   * 살아 있는 팩의 목록 (AC7·AC8) — `refundable` 이 환불 진입점의 스위치다: 조건 미충족이면
   * 화면이 그 버튼을 **그리지 않는다**(비노출). 소진·만료분은 목록에서 빠진다.
   */
  packs: { id: string; purchasedAt: string; expiresAt: string; credits: number; remaining: number; refundable: boolean }[];
  /**
   * 체납 단계 고지 (ISSUE-242 AC8) — past_due 일 때만 실린다: 단계와 그 단계의 거래 고지
   * 자구(화면이 자구를 지어내지 않는다). null = 체납 아님.
   */
  dunning: { stage: DunningStage; notice: string } | null;
}

export function consoleView(
  auth: BillingAuth,
  subscription: Subscription | null,
  destinations: Destination[],
  usage: UsageRecord,
  /** 팩 집계 입력 — 영속(Polar 웹훅)이 서기 전엔 빈 배열이다 (ISSUE-233 조각 3). */
  packs: readonly CreditPack[] = [],
  now: string = usage.lastAt ?? new Date().toISOString(),
): ConsoleView {
  assertAccountOwner(auth);
  const live = subscription !== null && subscription.status !== "canceled";
  const plan = planOfSubscription(subscription);
  const quota = quotaOf(plan);
  const dunningStage = dunningStageOf(subscription, now);
  return {
    accountId: auth.accountId,
    subscription: {
      status: live ? subscription.status : "free",
      updatedAt: subscription?.updatedAt ?? null,
      cancelAtPeriodEnd: live && subscription.cancelAtPeriodEnd === true,
    },
    // 체납 단계 고지 (ISSUE-242 AC8) — 각 단계 고지가 콘솔에 선다.
    dunning: dunningStage === null ? null : { stage: dunningStage, notice: DUNNING_NOTICES[dunningStage] },
    // 요금제 축 (#130) — 지금 무엇이고, 다음 주기에 무엇이 되는가. 카탈로그 자체는
    // `GET /v1/plans` 가 내므로 여기엔 **식별자만** 싣는다(값이 두 자리에 서지 않게).
    plan: plan.id,
    pendingPlan: subscription?.pendingPlan ?? null,
    interval: intervalOfSubscription(subscription),
    pendingInterval: subscription?.pendingInterval ?? null,
    destinations,
    processors: PROCESSORS,
    // ⭐ 「구독」/「해지」에 「요금제 변경」이 더해진다 — 활성 구독에서만 선다.
    // 기간 말 해지 접수분 (ISSUE-432) — 행동이 비어 선다: 해지는 이미 접수됐고(재해지 0),
    // 변경은 코어 판정이 409 로 막으며, 새 구독은 기간 말 canceled 가 닫은 뒤에 선다.
    actions:
      live && subscription.cancelAtPeriodEnd === true
        ? []
        : live
          ? subscription.status === "active"
            ? ["해지", "요금제 변경"]
            : ["해지"]
          : ["구독"],
    // ⚠️ 쿼터 칸은 「무료냐」가 아니라 **「쿼터가 유한한가」**로 선다: 하위 유료 층도 쿼터가
    //    있으므로, 유료를 무조건 null 로 두면 스탠다드 회원이 자기 잔량을 못 본다.
    freeTier:
      quota === null
        ? null
        : { monthlyCredits: quota, used: usage.credits, initialIndexUsed: usage.initialIndexAt !== null },
    usage: { period: usage.period, credits: usage.credits, lastAt: usage.lastAt },
    packsBalance: packsBalance(packs, now),
    packs: packs
      .filter((p) => packLive(p, now))
      .map((p) => ({
        id: p.id,
        purchasedAt: p.purchasedAt,
        expiresAt: p.expiresAt,
        credits: p.credits,
        remaining: p.remaining,
        refundable: packRefundable(p, now),
      })),
  };
}
