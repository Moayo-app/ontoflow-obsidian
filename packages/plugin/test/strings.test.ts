// 문구 카탈로그 (ISSUE-368) — 두 벌의 키 동치·로케일 감지·보간이 축이다.
import { describe, expect, it } from "vitest";

import { SENSITIVE_CONSENT_TEXT_EN } from "../src/core.js";
import { PLUGIN_STRINGS, detectLocale, fmt } from "../src/strings.js";

/** 병기 예외 (ISSUE-484) — ko 정본 화면에는 en 참고 번역이 서지 않는다: 빈 값이 설계다 (콘솔 ISSUE-438 ② 꼴). */
const EMPTY_BY_DESIGN = new Set(["ko.consentTextEn"]);

describe("플러그인 문구 카탈로그", () => {
  it("ko·en 두 벌은 같은 키를 지니고, 값은 전부 비지 않은 문자열이다", () => {
    const ko = Object.keys(PLUGIN_STRINGS.ko).sort();
    const en = Object.keys(PLUGIN_STRINGS.en).sort();
    expect(en).toEqual(ko);
    for (const locale of ["ko", "en"] as const) {
      for (const [key, value] of Object.entries(PLUGIN_STRINGS[locale])) {
        expect(typeof value, `${locale}.${key}`).toBe("string");
        if (EMPTY_BY_DESIGN.has(`${locale}.${key}`)) continue;
        expect(value.trim().length, `${locale}.${key}`).toBeGreaterThan(0);
      }
    }
  });

  it("동의 병기 — en 셸에만 참고 번역이 서고, ko 정본 화면은 비어 있다 (ISSUE-484)", () => {
    expect(PLUGIN_STRINGS.ko.consentTextEn).toBe("");
    // 참고 번역임이 문장에 선다 — 이 고지가 빠지면 병기가 정본 행세를 한다.
    expect(PLUGIN_STRINGS.en.consentTextEn).toContain("binding original");
    expect(PLUGIN_STRINGS.en.consentTextEn).toBe(SENSITIVE_CONSENT_TEXT_EN); // 한 벌 원천 — 콘솔과 갈리지 않는다
  });

  it("같은 {토큰} 자리가 두 벌에 똑같이 있다 — 보간이 로케일을 타지 않는다", () => {
    const tokens = (s: string) => [...s.matchAll(/\{([a-zA-Z]+)\}/g)].map((m) => m[1]).sort();
    for (const key of Object.keys(PLUGIN_STRINGS.ko) as (keyof typeof PLUGIN_STRINGS.ko)[]) {
      expect(tokens(PLUGIN_STRINGS.en[key]), String(key)).toEqual(tokens(PLUGIN_STRINGS.ko[key]));
    }
  });

  it("로케일은 옵시디언 getLanguage() 값에서 정한다 — ko 만 ko, 그 외·빈 값은 en", () => {
    expect(detectLocale("ko")).toBe("ko");
    expect(detectLocale("ja")).toBe("en");
    expect(detectLocale("en")).toBe("en");
    expect(detectLocale("")).toBe("en");
  });

  it("fmt 는 {토큰}을 치환하고 모르는 토큰은 그대로 둔다", () => {
    expect(fmt("노트 {n}건 — {name}", { n: 3, name: "vault" })).toBe("노트 3건 — vault");
    expect(fmt("잔량 {left}", { other: 1 })).toBe("잔량 {left}");
  });
});
