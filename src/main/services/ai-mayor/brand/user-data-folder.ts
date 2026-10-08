import path from "node:path";

/** WHERE THE PRODUCT KEEPS ITS DATA — everything under `%APPDATA%\AI Mayor`, whatever name the program was developed under. */
export const PRODUCT_FOLDER = "AI Mayor";

export function resolveUserDataFolder(appData: string): string {
  return path.join(appData, PRODUCT_FOLDER);
}
