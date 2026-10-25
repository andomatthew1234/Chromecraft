import path from "node:path";

import { app, nativeImage, type NativeImage } from "electron";

export function chromecraftIconPath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, "icons", "chromecraft.png")
    : path.resolve("resources", "icons", "chromecraft.png");
}

export function chromecraftIcon(size?: number): NativeImage {
  const icon = nativeImage.createFromPath(chromecraftIconPath());
  return size && !icon.isEmpty()
    ? icon.resize({ width: size, height: size, quality: "best" })
    : icon;
}
