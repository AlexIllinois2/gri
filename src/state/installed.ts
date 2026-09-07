import { INSTALLED_FILE, DATA_HOME } from "./paths.ts";
import { InstalledApp, InstalledStore } from "../types.ts";
import { readText, writeText } from "../util/io.ts";

export class InstalledStore_ {
  private data: InstalledStore;

  constructor(data: InstalledStore) {
    this.data = data;
  }

  static load(): InstalledStore_ {
    let raw: InstalledStore = {};
    const text = readText(INSTALLED_FILE);
    if (text) {
      try {
        raw = JSON.parse(text);
      } catch {
        raw = {};
      }
    }
    return new InstalledStore_(raw);
  }

  /** key 统一为 owner/repo 或 local 标识 */
  list(): InstalledApp[] {
    return Object.values(this.data);
  }

  ids(): string[] {
    return Object.keys(this.data);
  }

  get(id: string): InstalledApp | undefined {
    return this.data[id];
  }

  has(id: string): boolean {
    return id in this.data;
  }

  upsert(id: string, app: InstalledApp): void {
    this.data[id] = app;
    this.save();
  }

  remove(id: string): void {
    delete this.data[id];
    this.save();
  }

  save(): void {
    Bun.spawnSync(["mkdir", "-p", DATA_HOME]);
    writeText(INSTALLED_FILE, JSON.stringify(this.data, null, 2));
  }
}

/** 从 repo 推导短名：'astral-sh/uv' → 'uv' */
export function repoToName(repo: string): string {
  return repo.includes("/") ? repo.split("/").pop()! : repo;
}
