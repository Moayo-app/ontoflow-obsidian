// 등록된 패스키의 레코드 꼴 — 타입뿐인 잎 모듈 (#326).
//
// 원래 `webauthn.ts`(검증 순수 함수들)에 살았는데, `billing.ts` 가 이 레코드 꼴 하나 때문에
// 검증 모듈 전체를 타입으로 물었다. 옵시디언 공개 미러(#326)의 전이 폐쇄에 billing 이 들어
// 있어 타입 참조가 서버 모듈 공개를 끌고 오는 꼴이라, 레코드 꼴만 여기로 옮겼다.
// ⭐ 비밀이 없다 — 공개 키와 식별자뿐이다. `webauthn.ts` 가 재수출하므로 기존 호출부는 무변이다.

/** 등록된 패스키 하나. ⭐ 비밀이 없다 — 공개 키와 식별자뿐이다. */
export interface Passkey {
  /** `credentialId` (base64url) — 인증기가 준 식별자. */
  id: string;
  /** DER SPKI 공개 키 (base64url). `getPublicKey()` 가 준 바이트 그대로. */
  publicKey: string;
  /**
   * 인증기가 보고하는 사용 횟수. 0 이면 「세지 않는 인증기」다(플랫폼 패스키가 흔히 그렇다).
   * ⚠️ 0 인 인증기에 증가를 요구하면 멀쩡한 로그인이 막힌다 — `assertSignCount` 가 그 분기를 든다.
   */
  signCount: number;
  createdAt: string;
  /** 사람이 알아볼 이름. 화면이 지우기 전에 어느 것인지 가리는 자리다. */
  label: string;
}
