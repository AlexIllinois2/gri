import { BaseInstaller } from "./base.ts";
import { InstallContext } from "./base.ts";
import { ArchiveInstaller } from "./archive.ts";
import { AppImageInstaller } from "./appimage.ts";
import { RpmInstaller } from "./rpm.ts";
import { DebInstaller } from "./deb.ts";
import { RawExeInstaller } from "./exe.ts";
import { LayoutSpec } from "../types.ts";

export const INSTALLERS = [
  AppImageInstaller,
  RpmInstaller,
  DebInstaller,
  ArchiveInstaller,
  RawExeInstaller,
];

export function pickInstaller(
  assetPath: string,
  layout: LayoutSpec,
  ctx: InstallContext,
): BaseInstaller | null {
  for (const Klass of INSTALLERS) {
    const inst = new Klass(assetPath, layout, ctx);
    if (inst.detectType()) return inst;
  }
  return null;
}

export { BaseInstaller } from "./base.ts";
export type { InstallContext, BinSpec, PostInstallResult } from "./base.ts";
