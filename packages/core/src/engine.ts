// OpenAI 호환 추출 엔진 전송 (#88) — 모아요 서빙(vLLM)과 BYO(사용자 엔드포인트: Ollama·vLLM·
// LM Studio 류)가 같은 매핑을 쓴다. 계약(싱킹 off · temperature 0 · json_schema)은
// buildEngineCall/assertEngineContract 가 강제하고 여기는 전송만 산다 — 스키마를 못 받는
// 엔드포인트여도 위반 출력은 parseEngineOutput 이 기각하므로(#88 AC2) 정본 도달은 막힌다.
import { HubError, type Engine } from "./hub.js";

export type EngineFetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export interface OpenAiCompatConfig {
  baseUrl: string; // 예: http://localhost:11434 (BYO) · http://vllm.internal:8000 (모아요 서빙)
  /** 모델명 대체 — BYO 는 사용자 모델명(품질 비보증이라 선택은 사용자 몫), 비우면 호출의 모델(모아요 서빙 계약) 그대로. */
  model?: string | null;
  /** Authorization: Bearer — 값은 이 헤더로만 흐른다: 로그·오류 문구에 싣지 않는다 (#88 AC4). */
  apiKey?: string | null;
}

export function openAiCompatEngine(config: OpenAiCompatConfig, fetchFn: EngineFetchLike): Engine {
  if (config.baseUrl.trim().length === 0) {
    throw new HubError(400, ["추출 엔진 주소가 비어 있다"]);
  }
  const base = config.baseUrl.replace(/\/$/, "");
  const model = config.model ?? null;
  const apiKey = config.apiKey ?? null;
  return {
    async complete(call) {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (apiKey !== null && apiKey.length > 0) headers.authorization = `Bearer ${apiKey}`;
      const body = JSON.stringify({
        model: model === null || model.length === 0 ? call.model : model,
        messages: [{ role: "user", content: call.prompt }],
        temperature: call.temperature,
        // think:false 의 전송 꼴 — vLLM 챗 템플릿의 싱킹 스위치 (#270 운영 발견 1).
        // 다른 OpenAI 호환 서버는 모르는 필드를 무시한다 — 계약 위반이 아니다.
        chat_template_kwargs: { enable_thinking: call.think },
        // 스키마 강제 — 동사 enum 이 실린 output json_schema (#270 결의 3).
        response_format: {
          type: "json_schema",
          json_schema: { name: "ontoflow_extraction", strict: true, schema: call.schema },
        },
      });
      // ⚠️ **전송 자체의 실패**를 HubError 로 바꾼다. 전역 fetch 는 연결 거부·DNS 실패·시한
      //    초과를 `{ok:false}` 가 아니라 **거절(TypeError)** 로 낸다 — 그대로 흘리면
      //    extractIncremental 의 `e instanceof HubError` 를 지나쳐 **요청 전체가 죽는다**
      //    (노트 하나 보류로 끝날 일이 전부 유실로 보이는 자리). 서버리스 자세에서 유휴 뒤
      //    첫 호출이 바로 여기다.
      let res: { ok: boolean; status: number; text(): Promise<string> };
      try {
        res = await fetchFn(`${base}/v1/chat/completions`, { method: "POST", headers, body });
      } catch (e) {
        // 원인 문구는 싣지 않는다 — 주소·본문이 섞일 수 있다. 종류만. (engine 거절과 같은 자세)
        throw new HubError(502, [`추출 엔진에 닿지 못했다 (${(e as Error).name})`]);
      }
      if (!res.ok) {
        // 엔진 거절 본문은 싣지 않는다 — 상태만. 호출 측(코어)이 노트 단위 보류로 다룬다.
        throw new HubError(502, [`추출 엔진이 ${res.status} 로 거절했다`]);
      }
      const doc = JSON.parse(await res.text()) as {
        choices?: { message?: { content?: unknown } }[];
      };
      const content = doc.choices?.[0]?.message?.content;
      if (typeof content !== "string") {
        throw new HubError(502, ["추출 엔진 응답에 본문이 없다"]);
      }
      return content;
    },
  };
}
