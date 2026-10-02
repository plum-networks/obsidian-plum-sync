// Runtime stand-in for the "obsidian" module in unit tests (the npm package
// ships type definitions only). test/run.mjs aliases "obsidian" to this file;
// type-checking still uses the real obsidian.d.ts.

/** Every Notice shown during the test run, newest last. */
export const notices: string[] = [];
(globalThis as { __plumNotices?: string[] }).__plumNotices = notices;

export class Notice {
  constructor(message: string | DocumentFragment, _duration?: number) {
    notices.push(String(message));
  }
  setMessage(): this {
    return this;
  }
  hide(): void {}
}

export class TAbstractFile {
  path = "";
  name = "";
}

export class TFile extends TAbstractFile {
  stat = { ctime: 0, mtime: 0, size: 0 };
  basename = "";
  extension = "";
}

export class TFolder extends TAbstractFile {}

export function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/|\/$/g, "");
}

export function requestUrl(): never {
  throw new Error("network is not available in unit tests");
}

export class Modal {}
export class Plugin {}
export class PluginSettingTab {}
export class Setting {}
