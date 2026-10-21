import type { PlumSyncSettings } from "../types.js";

const trim = (p: string): string => "/" + p.replace(/^\/+/, "").replace(/\/+$/, "");

/**
 * Make `settings.base` (the 3-way sync base) belong to `root`, the remote
 * folder this sync uses. A base written for another folder must not be used:
 * the files it lists are missing from the new folder, and a missing remote
 * file with a base entry reads as "deleted on the box" — the local copy would
 * go to the trash. So a different folder starts from an empty base (every file
 * is then compared, uploaded or downloaded, never deleted).
 *
 * That happens when a connection with an app folder replaces an older one
 * (/Obsidian/<vault> → /Apps/…/<vault>) or the remote-folder setting changes.
 * A base saved by 0.2 has no `baseRoot`; it belongs to `legacyRoot`, the
 * folder 0.2 synced to. Returns true when the base was reset.
 */
export function useBaseFor(settings: PlumSyncSettings, root: string, legacyRoot: string): boolean {
  if (!settings.baseRoot) {
    settings.baseRoot = Object.keys(settings.base).length > 0 ? legacyRoot : root;
  }
  if (trim(settings.baseRoot) === trim(root)) return false;
  settings.base = {};
  settings.baseRoot = root;
  return true;
}
