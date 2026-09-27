import { z } from "zod";
import {
  APPS_DIR_DEFAULT,
  BIN_DIR_DEFAULT,
  CACHE_DIR_DEFAULT,
  CONFIG_FILE,
  CONFIG_HOME,
} from "./paths.ts";
import { ConfigData } from "../types.ts";
import { readText, writeText } from "../util/io.ts";

const ConfigSchema = z.object({
  downloadBackend: z.enum(["native", "aria2", "gh", "auto"]).default("auto"),
  cacheDir: z.string().default(CACHE_DIR_DEFAULT),
  binDir: z.string().default(BIN_DIR_DEFAULT),
  appsDir: z.string().default(APPS_DIR_DEFAULT),
  deleteAfterInstall: z.boolean().default(false),
});

export class ConfigStore {
  data: ConfigData;

  constructor(data: ConfigData) {
    this.data = data;
  }

  static load(): ConfigStore {
    let raw: Partial<ConfigData> = {};
    const text = readText(CONFIG_FILE);
    if (text) {
      try {
        raw = JSON.parse(text);
      } catch {
        raw = {};
      }
    }
    const parsed = ConfigSchema.parse(raw);
    return new ConfigStore(parsed as ConfigData);
  }

  save(): void {
    Bun.spawnSync(["mkdir", "-p", CONFIG_HOME]);
    writeText(CONFIG_FILE, JSON.stringify(this.data, null, 2));
  }

  get<K extends keyof ConfigData>(key: K): ConfigData[K] {
    return this.data[key];
  }
}
