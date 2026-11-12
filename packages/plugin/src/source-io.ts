// 소스 폴더 리더 (ISSUE-55) — vault 밖 md 폴더(일반·Logseq·클라우드 동기화 폴더)를 코어
// SourceReader 로 편다. 데스크톱 전용: 옵시디언 모바일에는 node fs 가 없다 — 그때는 조용한
// 0 수집이 아니라 명시 오류로 선다 (임의 보정 0). 번들은 browser 플랫폼이라 node 모듈을
// 정적 import 하지 않고, 데스크톱 런타임의 require 를 실행 시점에 집는다.
import type { SourceReader } from "./core.js";

// node:fs/promises 의 구조적 부분집합 — 테스트는 실제 모듈을 그대로 꽂는다.
export interface FolderFs {
  readdir(root: string, opts: { recursive: true }): Promise<string[]>;
  stat(path: string): Promise<{ mtimeMs: number; size: number; isFile(): boolean }>;
  readFile(path: string, encoding: "utf8"): Promise<string>;
}

export function nodeFolderFs(): FolderFs {
  const req = (globalThis as { require?: (m: string) => unknown }).require;
  if (typeof req !== "function") {
    throw new Error("소스 폴더 수집은 데스크톱 전용이다 — 이 기기에는 파일시스템 접근이 없다");
  }
  return req("node:fs/promises") as FolderFs;
}

/** 폴더 하나를 읽기 전용으로 편다 — 경로는 소스 루트 상대·`/` 구분(수집 상태의 키 꼴)이다. */
export function folderSourceReader(root: string, fs: FolderFs): SourceReader {
  const abs = (rel: string) => `${root}/${rel}`;
  return {
    async list() {
      const entries = await fs.readdir(root, { recursive: true });
      const out = [];
      for (const rel of entries.map((e) => e.replace(/\\/g, "/")).filter((e) => e.endsWith(".md"))) {
        const st = await fs.stat(abs(rel));
        if (st.isFile()) out.push({ path: rel, mtime: st.mtimeMs, size: st.size });
      }
      return out;
    },
    read: (rel) => fs.readFile(abs(rel), "utf8"),
  };
}
