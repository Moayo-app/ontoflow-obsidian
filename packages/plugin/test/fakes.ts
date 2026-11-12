// 테스트 가짜들 — 옵시디언 없이 구조적 어댑터 표면만 메모리로 충족한다.
import type { VaultReader } from "../src/core.js";
import type { ObsidianDataAdapter } from "../src/obsidian-io.js";

export interface FakeVault {
  adapter: ObsidianDataAdapter;
  files: Map<string, Uint8Array>;
  dirs: Set<string>;
}

export function fakeVault(): FakeVault {
  const files = new Map<string, Uint8Array>();
  const dirs = new Set<string>();
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const adapter: ObsidianDataAdapter = {
    async exists(path) {
      return files.has(path) || dirs.has(path);
    },
    async read(path) {
      const bytes = files.get(path);
      if (!bytes) throw new Error(`없는 파일: ${path}`);
      return dec.decode(bytes);
    },
    async readBinary(path) {
      const bytes = files.get(path);
      if (!bytes) throw new Error(`없는 파일: ${path}`);
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    },
    async write(path, data) {
      files.set(path, enc.encode(data));
    },
    async writeBinary(path, data) {
      files.set(path, new Uint8Array(data));
    },
    async mkdir(path) {
      dirs.add(path);
    },
    async rename(from, to) {
      const bytes = files.get(from);
      if (!bytes) throw new Error(`없는 파일: ${from}`);
      files.set(to, bytes);
      files.delete(from);
    },
    async remove(path) {
      // 옵시디언처럼 없는 경로의 제거는 던진다 — FileIo 쪽 무연산 보장은 obsidian-io 가 진다.
      if (!files.has(path)) throw new Error(`없는 파일: ${path}`);
      files.delete(path);
    },
  };
  return { adapter, files, dirs };
}

export function fakeReader(notes: Map<string, { body: string; mtime: number }>): VaultReader {
  return {
    list: async () =>
      [...notes.entries()].map(([path, n]) => ({ path, mtime: n.mtime, size: n.body.length })),
    read: async (path) => {
      const n = notes.get(path);
      if (!n) throw new Error(`없는 노트: ${path}`);
      return n.body;
    },
  };
}
