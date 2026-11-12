// 수집 소스 배선 (ISSUE-55) — 설정 목록의 복원과 폴더 리더(데스크톱 node fs)의 꼴.
import * as fsp from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { folderSourceReader, nodeFolderFs, type FolderFs } from "../src/source-io.js";
import { DEFAULT_SETTINGS, parseSettings } from "../src/settings.js";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("설정의 소스 목록 (#55 — 등록부가 수집의 분모)", () => {
  it("저장·복원이 왕복하고, 꼴이 어긋난 항목은 버린다", () => {
    const parsed = parseSettings({
      hubBaseUrl: "https://hub",
      sources: [
        { id: "logseq-main", kind: "logseq", root: "/Users/u/logseq" },
        { id: "나쁜 id", kind: "md", root: "/x" },
      ],
    });
    expect(parsed.sources).toEqual([{ id: "logseq-main", kind: "logseq", root: "/Users/u/logseq" }]);
    expect(parseSettings({}).sources).toEqual([]);
    expect(DEFAULT_SETTINGS.sources).toEqual([]);
  });
});

describe("폴더 리더 (데스크톱 전용)", () => {
  it("실제 폴더를 루트 상대 경로·`/` 구분으로 열고 md 만 올린다", async () => {
    const root = await mkdtemp(join(tmpdir(), "ontoflow-src-"));
    dirs.push(root);
    await fsp.mkdir(join(root, "journals"), { recursive: true });
    await fsp.writeFile(join(root, "journals", "2026_11_01.md"), "- 블록 [[a]]\n");
    await fsp.writeFile(join(root, "루트노트.md"), "본문\n");
    await fsp.writeFile(join(root, "그림.png"), "");

    const reader = folderSourceReader(root, fsp as unknown as FolderFs);
    const listed = (await reader.list()).map((f) => f.path).sort();
    expect(listed).toEqual(["journals/2026_11_01.md", "루트노트.md"]);
    expect(await reader.read("journals/2026_11_01.md")).toBe("- 블록 [[a]]\n");
    const stat = (await reader.list()).find((f) => f.path === "루트노트.md");
    expect(stat?.size).toBeGreaterThan(0);
    expect(stat?.mtime).toBeGreaterThan(0);
  });

  it("require 가 없는 런타임(모바일)에서는 명시 오류다 — 조용한 0 수집 금지", () => {
    // vitest(ESM)에는 globalThis.require 가 없다 — 모바일과 같은 조건이다.
    expect(() => nodeFolderFs()).toThrow(/데스크톱 전용/);
  });
});
