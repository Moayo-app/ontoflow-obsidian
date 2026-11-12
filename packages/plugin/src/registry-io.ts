// 등록부 파일의 플러그인 쪽 입출력 — 정본은 그래프 홈의 registry.yml (vault 안 파일, moayo-hq#271).
import {
  REGISTRY_FILE,
  StoreError,
  parseRegistry,
  resolveHome,
  serializeRegistry,
  type FileIo,
  type Registry,
} from "./core.js";

export async function loadRegistryFile(io: FileIo, vaultDir: string): Promise<Registry> {
  const home = await resolveHome(io, vaultDir);
  const text = await io.readText(`${home.dir}/${REGISTRY_FILE}`);
  if (text === null) {
    throw new StoreError([`등록부가 없다: ${home.dir}/${REGISTRY_FILE} — openVault 가 먼저다`]);
  }
  return parseRegistry(text);
}

export async function saveRegistryFile(io: FileIo, vaultDir: string, registry: Registry): Promise<void> {
  const home = await resolveHome(io, vaultDir);
  const path = `${home.dir}/${REGISTRY_FILE}`;
  const tmp = `${path}.tmp`;
  await io.writeText(tmp, serializeRegistry(registry));
  await io.rename(tmp, path);
}
