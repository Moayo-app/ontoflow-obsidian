// 요금제 카탈로그 (#130) — ⭐ **가격 숫자의 유일한 출처**다. 사이트 Pricing 페이지 · 허브
// 콘솔 · Polar 카탈로그 생성 스크립트가 전부 이 파일을 읽는다.
//
// ---- 왜 한 자리여야 하는가 ----
// 약관 제8조 ④ 가 「가격·결제주기·통화는 **구매 화면에 표시되며, 그 표시가 계약의 내용이
// 된다**」고 적었다. 구매 화면은 Polar 호스티드 체크아웃이다. 그래서 사이트에 적힌 숫자와
// Polar 상품의 숫자가 어긋나면 **계약 내용이 둘**이 되고, 그건 문구 실수가 아니라 분쟁이다.
// 사본을 두고 가드로 묶는 길(`chrome.ts` 의 `SELLER` 선례)도 있지만, 그쪽은 **정본이 다른
// 리포**에 있어 어쩔 수 없었던 경우다. 여기는 한 리포 안이라 사본을 둘 이유가 없다.
//
// ---- ⚠️ 무료 층은 요금제가 아니라 **바닥**이다 ----
// 약관 제8조 ② 「무료 범위는 구독 여부와 무관하게 제공되며, 구독을 해지하시더라도 계속
// 이용하실 수 있습니다」 · ③ 「이미 무료로 제공하던 기능을 **유료로 전환하지 않습니다**」.
// ⇒ 무료 층의 내용은 **고정**이고 위로만 쌓을 수 있다. 여기 `free` 칸이 카탈로그에 함께
//    사는 것은 화면이 네 칸을 나란히 그리기 때문이고, **구독 대상이 아니다**
//    (`subscribable` 가 거짓이다 — 체크아웃·변경이 그 칸을 집으면 거부된다).
//
// ---- 이 파일은 **아무것도 import 하지 않는다** ----
// `billing.ts` 가 이것을 읽으므로(쿼터 바인딩), 여기서 `BillingError` 를 끌어오면 순환이 된다.
// 그래서 모듈이 자기 오류를 든다 — `VaultError`·`OrgError`·`PasskeyError` 와 같은 규율이고,
// `hub/http.ts` 가 status 를 그대로 HTTP 로 옮긴다.

export class PlanError extends Error {
  constructor(
    readonly status: number,
    readonly problems: string[],
  ) {
    super(`요금제 거부 (${status}):\n- ${problems.join("\n- ")}`);
    this.name = "PlanError";
  }
}

// ---- 가격·할인·프리트라이얼의 도출 근거는 여기 없다 ----
// 정본은 `docs/policy/pricing-derivation.md` 다 (#130 도출 · 2026-11-12 이사, #326 — 공개
// 미러에 이 파일이 실려서다). 숫자를 바꾸려면 이 파일을, 근거가 바뀌면 그 문서를 바꾼다.

// ---- ⭕ 크레딧 개정 (#193·#197, 2026-11-06 — ISSUE-233) ----
//
// 쿼터의 단위가 「노트 수」에서 **크레딧**(추출 처리량)으로 바뀌었다 — 긴 파일을 쪼개라고
// 요구하지 않기 위해서다: 큰 파일은 더 들지만 **항상 처리**된다. #130 도출 모델은 역사적
// 근거로 그대로 산다(정본은 위 문서) — $15/$29 가 크레딧 체계로 승계됐고,
// 워크스페이스 3층($0/$20/$40)과 크레딧 팩이 더해졌다. 무료 층은 월 100노트 → **월 30크레딧**
// (#193 — 노트≈1크레딧이므로 후함의 축만 바뀐 게 아니라 인하다: 무료 층이 지배 비용이라서다).
// ⚠️ 소비처는 출시 시점에 닫힌다(제8조③ 방어): **증분 추출 + 노트 합성뿐** — 최초 색인·재부상·
//    동기화·내보내기·MCP 읽기는 영원히 0 이다. 소비처를 늘리는 것은 약관 개정 사안이다.

/** 1크레딧 = 추출 입력 ~4,000자 (#18/#44 실측으로 상수화). */
export const CREDIT_CHARS = 4000;

/** 처리량 → 크레딧 — 올림, 최소 1. 큰 파일은 더 들지만 거부·분할 요구는 없다 (#193). */
export function creditsForChars(chars: number): number {
  if (!Number.isFinite(chars) || chars < 0) {
    throw new PlanError(422, [`처리량이 수가 아닙니다: ${String(chars)}`]);
  }
  return Math.max(1, Math.ceil(chars / CREDIT_CHARS));
}

/**
 * 가격판 코호트 (ISSUE-242 AC9 — 약관 제8조 ⑦) — 이 파일의 가격이 바뀌는 날 **값을 올린다**:
 * 구독 레코드에 찍힌 코호트가 그 구독의 영구 가격판이고(워크스페이스 멤버 단가 포함 — #211 Q6),
 * 회사 발 인상은 코호트가 다른 **새 구독**에만 선다. 기존 구독의 인상은
 * assertPlanChangeEnforceable(30일 전 동의) 하나뿐이다 — 별도 좌석 인상 경로를 만들지 않는다.
 */
export const PLANS_COHORT = "2026-11";

/** 크레딧 팩 — 전 플랜 공통 일회성(구독이 아니라 제8조⑦ 코호트 밖이다). */
export const CREDIT_PACK = {
  usd: 15,
  credits: 1000,
  /** 유효 5년 — 상품권 법제 관행(#193 B4: 전금법 비대상 · 7일 미사용 전액 환불). */
  validYears: 5,
  refundDays: 7,
} as const;

/** Team Starter 의 멤버 상한 — 6번째 멤버가 유료 전환 방아쇠다 (#197). */
export const TEAM_STARTER_MAX_SEATS = 5;

/** 요금제 식별자 — 저장·API·Polar 매핑의 키다. 표기 이름은 `name` 이 든다. */
export type PlanId = "free" | "standard" | "pro" | "team-starter" | "team-standard" | "team-pro";

/** 무료 층 월 크레딧 — 결의값이다 (#193 · 쿼터→크레딧 개정). `billing.ts` 가 재수출한다. */
export const FREE_MONTHLY_CREDITS = 30;

/**
 * 가격 — ⭐ **합 타입인 것이 설계다.**
 *
 * `CLAUDE.md` §1 이 「가격 앵커 $14~20(앵커만 — **확정은 비범위**, 스펙 Q2)」로 두었고
 * Henry 판정(2026-11-02)도 「구조만 — 값은 자리로」다. 그래서 값이 **아직 없다**.
 *
 * ⚠️ 그 없음을 `0` 이나 `undefined` 로 적으면 화면이 「무료」나 「$NaN」을 그린다. 합 타입으로
 * 두면 **타입 검사가 모든 소비자에게 `tbd` 분기를 강제**한다 — 가격의 닫힌 기본이다.
 */
export type PlanPrice =
  | { kind: "free" }
  /** 값 미확정 — 화면은 「준비 중」을 그리고, 체크아웃·변경·Polar 생성은 거부한다. */
  | { kind: "tbd" }
  | { kind: "set"; monthlyUsd: number };

/** 결제 주기 (#132). 저장·API·Polar 상품 매핑의 둘째 축이다. */
export type BillingInterval = "month" | "year";

export const BILLING_INTERVALS: readonly BillingInterval[] = ["month", "year"];

/**
 * 연 결제가 청구하는 개월 수 — **1개월 무료** (#132, 도출 2026-11-03).
 *
 * ⭐ **연가를 저장하지 않고 이 상수로 파생한다.** 티어당 숫자가 **하나**로 남아야 하기
 * 때문이다(#130 이 세운 단일 소스 규율의 연장) — 두 수를 적으면 할인율이 티어마다 조용히
 * 어긋날 수 있고, 그러면 「월 × 11」이라는 **설명 가능한 규칙**이 사라진다.
 * 할인율을 바꾸려면 여기 **한 자리**만 고친다.
 *
 * ⚠️ 8.3%(= 1 - 11/12)인 근거는 이탈률이 아니다 — 도출의 정본은
 * `docs/policy/pricing-derivation.md` 다 (2026-11-12 이사, #326).
 */
export const ANNUAL_MONTHS_CHARGED = 11;

/** 할인율 — 표기용 파생값이다. 정본은 위 상수 하나다. */
export const ANNUAL_DISCOUNT = 1 - ANNUAL_MONTHS_CHARGED / 12;

/**
 * 주기별 청구 금액 (USD). 값이 없으면 `null` — 호출자가 「준비 중」을 그린다.
 * ⚠️ 연가는 **파생**이다: 저장된 수는 월가 하나뿐이다.
 */
export function priceUsdOf(plan: Plan, interval: BillingInterval): number | null {
  if (plan.price.kind !== "set") return null;
  return interval === "month" ? plan.price.monthlyUsd : plan.price.monthlyUsd * ANNUAL_MONTHS_CHARGED;
}

/** 연 결제의 **월 환산** — 화면이 「$13.75/월 (연 결제)」를 그리는 자리. */
export function yearlyPerMonthUsd(plan: Plan): number | null {
  const yearly = priceUsdOf(plan, "year");
  return yearly === null ? null : yearly / 12;
}

export interface Plan {
  id: PlanId;
  /**
   * 화면 표기 — 이름을 바꾸려면 **이 한 자리**다.
   *
   * ⚠️ **영문이다** (2026-11-03). 한글이었는데 Polar 대시보드에서 상품명이 영문으로 바뀌어
   * 둘이 어긋났다 — 상품명은 **결제 화면과 명세서에 그대로 찍히는 값**이고 퍼널이 옵시디언
   * 마켓(영어권)이므로 영문이 맞다. 설명(`blurb`)은 ko 그대로다: 그쪽은 사이트·콘솔이
   * 로케일별로 그리는 자리라 이름과 성격이 다르다.
   * ⭐ 이름이 어긋나면 **Polar 에 새 상품이 또 생긴다** — 카탈로그 CLI 는 기존 상품을
   *    고치지 않고 만들기만 한다. 그래서 여기가 대시보드와 같은 값이어야 한다.
   */
  name: string;
  /** 한 줄 설명 — 사이트 카드와 콘솔이 같은 문장을 쓴다 (ko). */
  blurb: string;
  /** 한 줄 설명의 영문 — en 표면(사이트 /en·콘솔 en)이 고른다 (ISSUE-354: ko 단일이던 갭). */
  blurbEn: string;
  price: PlanPrice;
  /**
   * 월 크레딧 (#193) — `null` = 무제한. 최초 전체 색인은 소비 0 이다 (AC7 · 사용자
   * 데이터베이스당 영구 1회). ⚠️ seatBased 플랜에서는 **멤버당** 값이고 지갑은 워크스페이스
   * 풀이다(풀 = 이 값 × 멤버 수 — #197 「좌석당 N 풀」).
   */
  monthlyCredits: number | null;
  /**
   * 제공 자리 저장 용량 상한 GB (ISSUE-446 — ⭕ Henry 판정 2026-11-16: 1/10/30, 크레딧
   * 지급량 비례 + 보수 버킷 — 출시 코호트에 영구(제8조⑦ 결)라 올리는 개정만 전 코호트에
   * 가능하다). **제공 자리에만** 선다 — 자기 PG·로컬(SQLite)은 이용자 인프라라 상한이 없다.
   * seatBased 플랜에서는 **멤버당** 값이고 상한은 워크스페이스 합(= 값 × 멤버 수 — 크레딧
   * 풀과 동형), 측정은 조직 제공 DB 전체다(#444). 초과 = 새 반영 **보류**뿐이다 — 기존
   * 데이터의 열람·내보내기·삭제는 어떤 경우에도 제한하지 않는다(소유 원칙 무변). 쓰기
   * 크레딧 차감안은 기각됐다(#446 — 이중 과금·멘털 모델 파괴·제8조③ 충돌).
   */
  seatStorageGb: number;
  /** 최초 색인 뒤의 전체 재색인 — 무료는 1회로 끝이다. */
  reindex: boolean;
  /**
   * 원격 MCP (#81) — 개인은 Pro 의 차별점(Henry 판정 2026-11-02), 워크스페이스는 **Team
   * Standard 부터**다(#193 개정, Henry 판정 2026-11-14 — 팀 가치 실현 지점이라 유료 전환
   * 유인으로 내림 · 빈도 상한은 층차 버킷이 든다, `rate-limit.ts`).
   */
  remoteMcp: boolean;
  /**
   * 구독 대상인가. `free` 는 거짓이다(바닥이라 살 것이 없다), `team` 도 거짓이다 —
   * 조직은 **좌석 과금**이라 개인 구독 축이 아니다(`org.ts` 의 `seatCount`·`updateSeats`).
   */
  subscribable: boolean;
  /** 좌석당 과금인가 — 화면이 「/좌석」을 붙이는 자리. */
  seatBased: boolean;
}

/**
 * ⭐ 정본. 순서가 화면 순서이고, 그것이 곧 **등급 순서**다 (`rankOf`).
 *
 * ⚠️ 크레딧 값(`monthlyCredits`)은 가격과 함께 **결의됐다** (#193·#197, 2026-11-06) —
 *    Free 30 · Standard 2,000 · Team 3층 동형. ⭕ **#193 재개정 (2026-11-15)**: Pro·Team Pro
 *    무제한 → **6,000**(멤버당 풀 동형) — 출시 가격이 코호트에 영구(제8조⑦)라 가장 후한 값은
 *    되돌릴 수 없는 베팅이었다: 상한은 올리는 개정만 전 코호트에 가능하다. 6,000 은 체감
 *    무제한(하루 ~200노트 변경)이고, 꼬리(무계 재색인·어뷰즈)만 팩($15/1,000)으로 돌린다.
 *    전체 재색인은 소비 0 그대로다(billing `initial-index` 분기 — 프롬프트 버전업 재색인 포함).
 *    🔁 재론은 노트당 한계원가 실측(#18)·실제 전환율이 설 때 — 가격과 같은 재론 조건이다.
 */
export const PLANS: readonly Plan[] = [
  {
    id: "free",
    name: "Free",
    blurb: "최초 색인 1회와 월 30크레딧, 주간 리포트 — 기한 없이 무료입니다.",
    blurbEn: "One initial index, 30 credits a month and a weekly report — free with no time limit.",
    price: { kind: "free" },
    monthlyCredits: FREE_MONTHLY_CREDITS,
    seatStorageGb: 1,
    reindex: false,
    remoteMcp: false,
    subscribable: false, // 바닥이다 — 살 것이 없다 (약관 제8조 ②③)
    seatBased: false,
  },
  {
    id: "standard",
    name: "Standard",
    blurb: "월 2,000크레딧과 전체 재색인 — 매일 쓰기에 넉넉한 용량입니다.",
    blurbEn: "2,000 credits a month and full re-index — room for everyday writing.",
    // 도출 2026-11-03 (#130) → 크레딧 승계 2026-11-06 (#193·#197).
    price: { kind: "set", monthlyUsd: 15 },
    monthlyCredits: 2000,
    seatStorageGb: 10,
    reindex: true,
    remoteMcp: false,
    subscribable: true,
    seatBased: false,
  },
  {
    id: "pro",
    name: "Pro",
    blurb: "월 6,000크레딧과 원격 MCP — 외부 AI 도구까지 그래프에 연결됩니다.",
    blurbEn: "6,000 credits a month and remote MCP — connect external AI tools to your graph.",
    price: { kind: "set", monthlyUsd: 29 },
    monthlyCredits: 6000, // ⭕ #193 재개정 (2026-11-15) — 무제한 → 6,000 (머리주석)
    seatStorageGb: 30,
    reindex: true,
    remoteMcp: true, // ⭐ 상위 층의 차별점 (#81)
    subscribable: true,
    seatBased: false,
  },
  // ---- 워크스페이스 3층 (#197) — 멤버당 과금 · 지갑은 워크스페이스 풀 · 그래프는 공유
  // 합집합(#191)뿐이다. subscribable 이 거짓인 이유: 가입은 워크스페이스 생성 + 멤버
  // 동기(org.ts)가 지고, 개인 구독 변경 경로가 집으면 안 된다.
  {
    id: "team-starter",
    name: "Team Starter",
    blurb: "멤버 5명까지 무료 — 크레딧은 워크스페이스가 함께 씁니다.",
    blurbEn: "Free for up to 5 members — credits are pooled across the workspace.",
    price: { kind: "free" }, // ⭕ 조직의 바닥이 생겼다 (#197 — 옛 「조직 무료 층 없음」 개정)
    monthlyCredits: FREE_MONTHLY_CREDITS,
    seatStorageGb: 1,
    reindex: false,
    remoteMcp: false,
    subscribable: false,
    seatBased: true,
  },
  {
    id: "team-standard",
    name: "Team Standard",
    blurb: "멤버당 월 2,000크레딧 풀에 원격 MCP 를 더합니다 — 외부 AI 도구가 팀 그래프에 연결됩니다.",
    blurbEn: "A pool of 2,000 credits per member a month, plus remote MCP — external AI tools connect to the team graph.",
    price: { kind: "set", monthlyUsd: 20 },
    monthlyCredits: 2000,
    seatStorageGb: 10,
    reindex: true,
    remoteMcp: true, // ⭕ #193 개정 (2026-11-14) — 팀은 Standard 부터, 버킷은 보수 층 (rate-limit.ts)
    subscribable: false,
    seatBased: true,
  },
  {
    id: "team-pro",
    name: "Team Pro",
    blurb: "멤버당 월 6,000크레딧 풀, SSO·SCIM — 모든 기능이 포함됩니다.",
    blurbEn: "A pool of 6,000 credits per member a month, SSO and SCIM — everything included.",
    price: { kind: "set", monthlyUsd: 40 },
    monthlyCredits: 6000, // ⭕ #193 재개정 (2026-11-15) — 무제한 → 멤버당 6,000 풀
    seatStorageGb: 30,
    reindex: true,
    remoteMcp: true,
    subscribable: false,
    seatBased: true,
  },
];

const BY_ID = new Map<PlanId, Plan>(PLANS.map((plan) => [plan.id, plan]));

export function isPlanId(id: string): id is PlanId {
  return BY_ID.has(id as PlanId);
}

/** 모르는 id 는 **추측하지 않는다** — 닫힌 기본으로 422 다. */
export function planOf(id: string): Plan {
  const plan = BY_ID.get(id as PlanId);
  if (plan === undefined) throw new PlanError(422, [`모르는 요금제입니다: ${id}`]);
  return plan;
}

/** 등급 — `PLANS` 순서가 그것이다. 업/다운그레이드 판정의 축 (`decidePlanSwitch`). */
export function rankOf(id: PlanId): number {
  return PLANS.findIndex((plan) => plan.id === id);
}

/** 무료 층 — 구독이 없을 때의 요금제다. */
export const FREE_PLAN: Plan = planOf("free");

/**
 * 가격이 박혔는가. ⚠️ 체크아웃·요금제 변경·Polar 상품 생성이 **전부** 이것을 먼저 묻는다 —
 * 값 없는 요금제를 팔 수는 없다.
 */
export function priceIsSet(plan: Plan): boolean {
  return plan.price.kind === "set";
}

/**
 * 살 수 있는 요금제인가. 둘을 함께 본다 — **무엇인가**(바닥·좌석 축이 아닌가)와
 * **값이 있는가**. 뒤쪽이 지금 전원을 막지만(가격 `tbd`), 막는 이유가 다르므로 문안이 다르다.
 */
export function assertSubscribable(plan: Plan): void {
  if (!plan.subscribable) {
    throw new PlanError(422, [
      plan.id === "free"
        ? "무료 층은 구독 대상이 아닙니다 — 해지하면 그 자리로 돌아갑니다 (약관 제8조 ②)"
        : `${plan.name} 은 좌석 과금이라 개인 구독 경로가 아닙니다 — 워크스페이스를 만들어 좌석을 늘려 주세요`,
    ]);
  }
  if (!priceIsSet(plan)) {
    // 닫힌 기본 — 값이 박히기 전에는 팔 수 없다 (#130 ⑵ 판정).
    throw new PlanError(503, [`${plan.name} 의 가격이 아직 확정되지 않았습니다 — 준비 중입니다`]);
  }
}

/** 월 크레딧 — `null` 은 무제한이다. `decideExtraction` 이 이 값으로 선다. */
export function quotaOf(plan: Plan): number | null {
  return plan.monthlyCredits;
}

/** 워크스페이스 풀 — 멤버당 크레딧 × 멤버 수 (#197 「좌석당 N 풀」). 무제한은 그대로다. */
export function teamPoolOf(plan: Plan, seats: number): number | null {
  if (!plan.seatBased) throw new PlanError(422, [`${plan.name} 은 워크스페이스 플랜이 아닙니다`]);
  if (!Number.isInteger(seats) || seats < 1) throw new PlanError(422, [`멤버 수가 양의 정수가 아닙니다: ${seats}`]);
  return plan.monthlyCredits === null ? null : plan.monthlyCredits * seats;
}

/**
 * 제공 자리 저장 용량 상한 — 바이트 (ISSUE-446). 개인은 플랜값 그대로, 워크스페이스는
 * 멤버당 × 멤버 수(크레딧 풀과 동형 — 측정도 조직 제공 DB 전체다). 자기 PG 는 이 함수를
 * 지나지 않는다(상한 없음 — 호출처가 제공 자리 자격증명 경로에만 산다).
 */
export function seatStorageLimitBytes(plan: Plan, seats: number): number {
  const units = plan.seatBased ? Math.max(1, seats) : 1;
  return plan.seatStorageGb * units * 1024 ** 3;
}
