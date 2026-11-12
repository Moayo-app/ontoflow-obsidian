// 플러그인의 전송 자리 (#105) — 허브·BYO 호출은 전부 옵시디언 `requestUrl` 로 간다.
//
// 왜 fetch 가 아닌가: 플러그인 렌더러의 출처는 `app://obsidian.md` 라 fetch 는 CORS 를 받는다.
// 특히 BYO 로컬 엔드포인트(#88 — Ollama·LM Studio 류)는 서버 쪽 허용 출처 설정 없이는 차단이라,
// 「본문이 기기를 떠나지 않는다」는 길이 실사용에서 서지 않는다. requestUrl 은 그 우회로이고
// 모바일에서도 같은 코드로 선다(isDesktopOnly false 를 지탱하는 축의 하나).
//
// 규율은 그대로 승계한다: 이 모듈은 로그를 쓰지 않고, 토큰도 응답 원문도 되비치지 않는다
// (#12 AC5 · #88 AC4). 상태와 본문을 호출자(hub-client·engine)에게 넘기는 것이 전부다.
import { requestUrl } from "obsidian";

export interface NetResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

/**
 * hub-client 의 `FetchLike` 와 코어 engine 의 `EngineFetchLike` 를 동시에 충족하는 전송.
 * `throw: false` 가 핵심이다 — 4xx·5xx 를 예외로 바꾸지 않고 상태로 돌려줘야 호출자가
 * problems 를 읽고 보류·기각을 가를 수 있다 (requestUrl 의 기본값은 throw 다).
 */
export async function obsidianFetch(
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
): Promise<NetResponse> {
  const res = await requestUrl({
    url,
    method: init.method,
    headers: init.headers,
    body: init.body,
    throw: false,
  });
  const text = res.text;
  return {
    ok: res.status >= 200 && res.status < 300,
    status: res.status,
    text: async () => text,
  };
}
