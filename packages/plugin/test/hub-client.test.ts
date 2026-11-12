import { describe, expect, it } from "vitest";
import { SEED_REGISTRY } from "../src/core.js";
import { HubClientError, hubClient, type FetchLike } from "../src/hub-client.js";

const okBody = JSON.stringify({ add: [], retract: [], proposals: [], held: [] });

function captureFetch(status = 200, body = okBody) {
  const calls: { url: string; init: { method: string; headers: Record<string, string>; body: string } }[] =
    [];
  const fetchFn: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return { ok: status >= 200 && status < 300, status, text: async () => body };
  };
  return { calls, fetchFn };
}

describe("허브 클라이언트 — 토큰은 헤더로만, 오류에 되비침 0 (AC5)", () => {
  it("토큰은 Authorization 헤더로만 흐른다", async () => {
    const { calls, fetchFn } = captureFetch();
    const hub = hubClient("https://hub.test/", async () => "tok-비밀", fetchFn);
    await hub.extractIncremental({ registry: SEED_REGISTRY, changes: [], context: [] });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://hub.test/v1/extract/incremental");
    expect(calls[0]!.init.method).toBe("POST");
    expect(calls[0]!.init.headers.authorization).toBe("Bearer tok-비밀");
    expect((JSON.parse(calls[0]!.init.body) as { registry: { version: number } }).registry.version).toBe(
      SEED_REGISTRY.version,
    );
  });

  it("오류는 상태·problems 만 나른다 — 토큰 되비침 0", async () => {
    const { fetchFn } = captureFetch(422, JSON.stringify({ problems: ["등록부 밖 동사다"] }));
    const hub = hubClient("https://hub.test", async () => "tok-비밀", fetchFn);
    const err = (await hub
      .extractIncremental({ registry: SEED_REGISTRY, changes: [], context: [] })
      .catch((e: unknown) => e)) as HubClientError;
    expect(err).toBeInstanceOf(HubClientError);
    expect(err.status).toBe(422);
    expect(err.problems).toEqual(["등록부 밖 동사다"]);
    expect(String(err)).not.toContain("tok-비밀");
  });

  it("JSON 아닌 오류 본문 — 원문을 싣지 않고 상태만 나른다", async () => {
    const { fetchFn } = captureFetch(500, "<html>내부비밀</html>");
    const hub = hubClient("https://hub.test", async () => "t", fetchFn);
    const err = (await hub
      .extractIncremental({ registry: SEED_REGISTRY, changes: [], context: [] })
      .catch((e: unknown) => e)) as HubClientError;
    expect(err.problems).toEqual(["허브가 500 로 거절했다"]);
    expect(String(err)).not.toContain("내부비밀");
  });

  it("토큰·주소가 없으면 호출 전에 선다 — fetch 0", async () => {
    const { calls, fetchFn } = captureFetch();
    const noToken = hubClient("https://hub.test", async () => null, fetchFn);
    await expect(noToken.extractReindex({ registry: SEED_REGISTRY, notes: [] })).rejects.toThrow(
      /토큰이 없다/,
    );
    const noBase = hubClient("", async () => "t", fetchFn);
    await expect(noBase.extractReindex({ registry: SEED_REGISTRY, notes: [] })).rejects.toThrow(
      /주소가 설정되지 않았다/,
    );
    expect(calls).toHaveLength(0);
  });

  it("재색인 경로 — /v1/extract/reindex 로 간다", async () => {
    const reBody = JSON.stringify({
      edges: [],
      proposals: [],
      held: [],
      versions: { registry: 1, prompt: "p1" },
    });
    const { calls, fetchFn } = captureFetch(200, reBody);
    const hub = hubClient("https://hub.test", async () => "t", fetchFn);
    const res = await hub.extractReindex({
      registry: SEED_REGISTRY,
      notes: [{ note: "a.md", body: "본문" }],
    });
    expect(calls[0]!.url).toBe("https://hub.test/v1/extract/reindex");
    expect(res.versions.prompt).toBe("p1");
  });
});
