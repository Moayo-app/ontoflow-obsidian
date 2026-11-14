import { describe, expect, it } from "vitest";
import { SEED_REGISTRY } from "../src/core.js";
import { HubClientError, hubClient, type FetchLike } from "../src/hub-client.js";

const okBody = JSON.stringify({ add: [], retract: [], proposals: [], held: [] });

function captureFetch(status = 200, body = okBody) {
  const calls: { url: string; init: { method: string; headers: Record<string, string>; body?: string } }[] =
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
    expect((JSON.parse(calls[0]!.init.body ?? "") as { registry: { version: number } }).registry.version).toBe(
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

// 워크스페이스 문맥 (ISSUE-365) — 과금 문맥과 투영 축의 분리가 이 클라이언트의 계약이다:
// orgId 는 크레딧 소비처(추출·합성·출고)에만 실리고, 개인 정본 canonical* 는 결코 지나지 않는다.
describe("워크스페이스 문맥 (ISSUE-365)", () => {
  const body = (c: { init: { body?: string } }) => JSON.parse(c.init.body ?? "{}") as Record<string, unknown>;

  it("워크스페이스가 서 있으면 추출·합성에 orgId 가 실린다 — 풀 지갑 과금", async () => {
    const { calls, fetchFn } = captureFetch(200, JSON.stringify({ title: "t", md: "m" }));
    const hub = hubClient("https://hub.test", async () => "tok", fetchFn, () => "org-1");
    await hub.extractIncremental({ registry: SEED_REGISTRY, changes: [], context: [] });
    await hub.synthesize({ sourceId: "s", nodes: [], edges: [{ s: "a", v: "연관", o: "b" }] } as never);
    expect(body(calls[0]!).orgId).toBe("org-1");
    expect(body(calls[1]!).orgId).toBe("org-1");
  });

  it("개인 정본 canonical* 에는 orgId 가 실리지 않는다 — 정본 축 분리", async () => {
    const { calls, fetchFn } = captureFetch(200, JSON.stringify({ rev: 1 }));
    const hub = hubClient("https://hub.test", async () => "tok", fetchFn, () => "org-1");
    await hub.canonicalLoad();
    await hub.canonicalFlush({ rev: 1 } as never);
    expect(body(calls[0]!).orgId).toBeUndefined();
    expect(body(calls[1]!).orgId).toBeUndefined();
  });

  it("workspaceLoad·Flush 는 orgId 를 명시로 싣고, 미선택이면 호출 전에 선다", async () => {
    const { calls, fetchFn } = captureFetch(200, JSON.stringify({ rev: 3 }));
    const hub = hubClient("https://hub.test", async () => "tok", fetchFn, () => "org-1");
    await hub.workspaceLoad();
    await hub.workspaceFlush({ rev: 3 } as never);
    expect(calls[0]!.url).toBe("https://hub.test/v1/canonical/pg/load");
    expect(body(calls[0]!).orgId).toBe("org-1");
    expect(body(calls[1]!).orgId).toBe("org-1");

    const none = hubClient("https://hub.test", async () => "tok", fetchFn);
    expect(() => none.workspaceLoad()).toThrowError(/워크스페이스/);
    expect(calls).toHaveLength(2); // 미선택은 전송 전에 선다 — 네트워크 0
  });

  it("listWorkspaces 는 GET /v1/orgs 를 돌려 전환기 재료만 추린다", async () => {
    const { calls, fetchFn } = captureFetch(
      200,
      JSON.stringify({ orgs: [{ orgId: "org-1", name: "모아요", role: "owner", seats: 3, presets: [] }] }),
    );
    const hub = hubClient("https://hub.test", async () => "tok", fetchFn);
    const orgs = await hub.listWorkspaces();
    expect(calls[0]!.init.method).toBe("GET");
    expect(calls[0]!.init.body).toBeUndefined();
    expect(orgs).toEqual([{ orgId: "org-1", name: "모아요", role: "owner" }]);
  });
});

// API 소스 오케스트레이션 (ISSUE-364) — 분모 조회와 pull 둘 다 워크스페이스 문맥(orgId)을 싣는다:
// 관리자가 조직 금고에 연결한 소스를 멤버 플러그인이 당기는 길이다.
describe("API 소스 수집 호출 (ISSUE-364)", () => {
  it("ingestSources 는 kinds 를 추리고, 워크스페이스 문맥이면 orgId 가 실린다", async () => {
    const { calls, fetchFn } = captureFetch(200, JSON.stringify({ kinds: ["notion", "jira"] }));
    const hub = hubClient("https://hub.test", async () => "tok", fetchFn, () => "org-1");
    const kinds = await hub.ingestSources();
    expect(kinds).toEqual(["notion", "jira"]);
    expect(calls[0]!.url).toBe("https://hub.test/v1/ingest/sources");
    expect((JSON.parse(calls[0]!.init.body ?? "{}") as { orgId?: string }).orgId).toBe("org-1");
  });

  it("ingestPull 은 kind 라우트에 known 을 싣는다", async () => {
    const { calls, fetchFn } = captureFetch(200, JSON.stringify({ pages: [] }));
    const hub = hubClient("https://hub.test", async () => "tok", fetchFn);
    await hub.ingestPull("notion", { p1: 1000 });
    expect(calls[0]!.url).toBe("https://hub.test/v1/ingest/notion");
    const body = JSON.parse(calls[0]!.init.body ?? "{}") as { known: unknown; orgId?: string };
    expect(body.known).toEqual({ p1: 1000 });
    expect(body.orgId).toBeUndefined(); // 개인 문맥 — orgId 없음
  });
});

describe("인증 핑 (ISSUE-372)", () => {
  it("GET /v1/account 한 번 — 성공은 조용하고, 거절은 상태·problems 로 선다", async () => {
    const calls: string[] = [];
    const ok = hubClient("https://hub.test", async () => "tok", async (url, init) => {
      calls.push(`${init.method ?? "GET"} ${url}`);
      return { ok: true, status: 200, text: async () => "{}" };
    });
    await ok.ping();
    expect(calls).toEqual(["GET https://hub.test/v1/account"]);

    const dead = hubClient("https://hub.test", async () => "tok", async () => ({
      ok: false,
      status: 401,
      text: async () => JSON.stringify({ problems: ["다른 데서 로그인했다"] }),
    }));
    await expect(dead.ping()).rejects.toThrowError(/401|로그인/);
  });
});

describe("동기화 집행 (ISSUE-372 — 출고 표면)", () => {
  it("projectTo 가 목적지 경로로 입력을 그대로 나른다", async () => {
    const calls: { url: string; body: unknown }[] = [];
    const hub = hubClient("https://hub.test", async () => "tok", async (url, init) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({ written: {}, newMappings: [], syncedLocalIds: [], removedLocalIds: [], failure: null }),
      };
    });
    const input = { registry: { verbs: [] }, delta: { nodes: [], edges: [], removals: [] }, mapping: {} };
    const out = await hub.projectTo("notion", input);
    expect(calls[0]?.url).toBe("https://hub.test/v1/project/notion");
    expect(calls[0]?.body).toEqual(input);
    expect(out.failure).toBeNull();
    await hub.projectTo("postgres", input);
    expect(calls[1]?.url).toBe("https://hub.test/v1/project/postgres");
  });
});
