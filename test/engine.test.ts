import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { TFile } from "obsidian";
import {
  PlumApiError,
  PlumClient,
  type DriveEntry,
  type HttpRequest,
  type HttpResponse,
  type ListOptions,
} from "@plumbox/client";
import type PlumSyncPlugin from "../src/main.js";
import { SyncEngine, syncTargetKey } from "../src/sync/engine.js";
import { DEFAULT_SETTINGS, type PlumSyncSettings } from "../src/types.js";

const ROOT = "/Obsidian/Vault";
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dec = (b: Uint8Array): string => new TextDecoder().decode(b);
const sha = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");
const toAB = (b: Uint8Array): ArrayBuffer => b.slice().buffer as ArrayBuffer;
const notices = (): string[] => (globalThis as { __plumNotices?: string[] }).__plumNotices ?? [];

/** In-memory vault with Obsidian's semantics that matter here: TFile objects are live. */
class FakeVault {
  configDir = ".obsidian";
  private files = new Map<string, { file: TFile; data: Uint8Array }>();
  private folders = new Set<string>();
  private clock = 1_000;
  trashed: string[] = [];
  failRead = new Set<string>();

  getName(): string {
    return "Vault";
  }
  getFiles(): TFile[] {
    return [...this.files.values()].map((e) => e.file);
  }
  getAbstractFileByPath(p: string): TFile | null {
    return this.files.get(p)?.file ?? null;
  }
  write(path: string, data: Uint8Array | string): void {
    const bytes = typeof data === "string" ? enc(data) : data;
    const e = this.files.get(path);
    if (e) {
      e.data = bytes;
      e.file.stat.mtime = ++this.clock;
      e.file.stat.size = bytes.length;
      return;
    }
    const f = new TFile();
    f.path = path;
    f.name = path.slice(path.lastIndexOf("/") + 1);
    f.stat = { ctime: this.clock, mtime: ++this.clock, size: bytes.length };
    this.files.set(path, { file: f, data: bytes });
  }
  read(path: string): string | undefined {
    const e = this.files.get(path);
    return e ? dec(e.data) : undefined;
  }
  has(path: string): boolean {
    return this.files.has(path);
  }
  remove(path: string): void {
    this.files.delete(path);
  }
  removeUnder(prefix: string): void {
    for (const p of [...this.files.keys()]) if (p.startsWith(prefix + "/")) this.files.delete(p);
  }
  adapter = {
    readBinary: async (p: string): Promise<ArrayBuffer> => {
      if (this.failRead.has(p)) throw new Error("EACCES");
      const e = this.files.get(p);
      if (!e) throw new Error(`ENOENT ${p}`);
      return toAB(e.data);
    },
    writeBinary: async (p: string, buf: ArrayBuffer): Promise<void> => {
      this.write(p, new Uint8Array(buf));
    },
    exists: async (p: string): Promise<boolean> =>
      this.folders.has(p) || this.files.has(p) || [...this.files.keys()].some((k) => k.startsWith(p + "/")),
  };
  createFolder = async (p: string): Promise<void> => {
    this.folders.add(p);
  };
  trash = async (f: TFile, _system: boolean): Promise<void> => {
    this.files.delete(f.path);
    this.trashed.push(f.path);
  };
}

/** In-memory stand-in for the box's Drive API (paged recursive listing). */
class FakeDrive {
  files = new Map<string, { data: Uint8Array; remote?: boolean; noHash?: boolean }>();
  removed: string[] = [];
  listError: unknown = null;
  /** Runs while the listing is in flight (simulates edits during a pass). */
  onList: (() => void) | null = null;
  /** Run once while a download / an upload is in flight. */
  onDownload: (() => void) | null = null;
  onUpload: (() => void) | null = null;

  put(rel: string, content: string, extra: { remote?: boolean; noHash?: boolean } = {}): void {
    this.files.set(`${ROOT}/${rel}`, { data: enc(content), ...extra });
  }
  has(rel: string): boolean {
    return this.files.has(`${ROOT}/${rel}`);
  }
  drop(rel: string): void {
    this.files.delete(`${ROOT}/${rel}`);
  }
  async ensureDir(_p: string): Promise<void> {}
  async list(path: string, opts: ListOptions = {}) {
    if (this.listError) throw this.listError;
    this.onList?.();
    this.onList = null;
    const prefix = path.replace(/\/+$/, "") + "/";
    const items: Array<DriveEntry & { remote?: boolean }> = [];
    for (const [p, f] of [...this.files].sort(([a], [b]) => a.localeCompare(b))) {
      if (!p.startsWith(prefix)) continue;
      items.push({
        name: p.slice(p.lastIndexOf("/") + 1),
        path: p,
        isDir: false,
        size: f.data.length,
        modTime: "2026-01-01T00:00:00Z",
        ...(f.noHash ? {} : { hash: sha(f.data) }),
        ...(f.remote ? { remote: true } : {}),
      });
    }
    const offset = opts.offset ?? 0;
    const limit = opts.limit ?? 100;
    return { items: items.slice(offset, offset + limit), total: items.length, limit, offset };
  }
  async download(path: string): Promise<ArrayBuffer> {
    this.onDownload?.();
    this.onDownload = null;
    const f = this.files.get(path);
    if (!f) throw new PlumApiError(404, "not found");
    return toAB(f.data);
  }
  async upload(path: string, data: ArrayBuffer | Uint8Array | string): Promise<DriveEntry> {
    this.onUpload?.();
    this.onUpload = null;
    const bytes = typeof data === "string" ? enc(data) : new Uint8Array(data as ArrayBuffer);
    this.files.set(path, { data: bytes });
    return { name: "", path, isDir: false, size: bytes.length, modTime: "" };
  }
  async remove(path: string): Promise<void> {
    this.files.delete(path);
    this.removed.push(path);
  }
}

interface FakePlugin {
  app: { vault: FakeVault };
  settings: PlumSyncSettings;
  saveSettings: () => Promise<void>;
  prompts: number;
  promptHeldDeletions: (force: boolean) => void;
}

let vault: FakeVault;
let drive: FakeDrive;
let plugin: FakePlugin;

function engineFor(client: unknown = { drive }): SyncEngine {
  return new SyncEngine(plugin as unknown as PlumSyncPlugin, {
    makeClient: () => client as PlumClient,
  });
}

const note = (i: number): string => `notes/n${String(i).padStart(3, "0")}.md`;
const boxText = (rel: string): string | undefined => {
  const f = drive.files.get(`${ROOT}/${rel}`);
  return f ? dec(f.data) : undefined;
};
/** Conflict copies in the vault, sorted. */
const conflictCopies = (): string[] =>
  vault
    .getFiles()
    .map((f) => f.path)
    .filter((p) => p.includes("(conflict "))
    .sort();

/** n notes synced to the box — a settled vault. */
async function settled(engine: SyncEngine, n: number): Promise<void> {
  for (let i = 0; i < n; i++) vault.write(note(i), `note ${i}`);
  const r = await engine.run();
  assert.ok(r);
  assert.equal(r.uploaded, n);
  assert.equal(Object.keys(plugin.settings.base).length, n);
}

beforeEach(() => {
  vault = new FakeVault();
  drive = new FakeDrive();
  plugin = {
    app: { vault },
    settings: {
      ...DEFAULT_SETTINGS,
      base: {},
      baseUrl: "https://pb-test.plumbox.me",
      token: "t",
      account: "me@example.com",
      remoteRoot: ROOT,
    },
    saveSettings: async () => {},
    prompts: 0,
    promptHeldDeletions() {
      this.prompts++;
    },
  };
});

describe("SyncEngine: incomplete listings", () => {
  it("aborts on 503 listing_incomplete with no deletions and a visible error", async () => {
    const engine = engineFor();
    await settled(engine, 5);
    drive.listError = new PlumApiError(503, "Some folders could not be read", "listing_incomplete");
    vault.remove(note(0)); // would otherwise be deleted on the box
    const baseBefore = JSON.stringify(plugin.settings.base);
    const shown = notices().length;

    const r = await engine.run();
    assert.equal(r, null);
    assert.deepEqual(drive.removed, []);
    assert.deepEqual(vault.trashed, []);
    assert.equal(JSON.stringify(plugin.settings.base), baseBefore);
    assert.match(engine.lastError, /incomplete/);
    assert.ok(notices().slice(shown).some((m) => /incomplete/.test(m)), "a Notice explains it");
    assert.equal(engine.isRunning, false);
  });

  it("aborts on a real 503 response through the SDK (not swallowed into an empty list)", async () => {
    const engine = engineFor();
    await settled(engine, 3);
    const http = {
      async request(req: HttpRequest): Promise<HttpResponse> {
        const [status, json] = req.url.includes("/api/drive/list")
          ? [503, { error: "listing_incomplete", message: "Some folders could not be read" }]
          : [409, { error: "exists" }];
        return { status, headers: {}, body: toAB(enc(JSON.stringify(json))) };
      },
    };
    const client = new PlumClient({ baseUrl: "https://pb-test.plumbox.me", token: "t", http });
    const r = await engineFor(client).run();
    assert.equal(r, null);
    for (let i = 0; i < 3; i++) assert.ok(vault.has(note(i)));
    assert.deepEqual(vault.trashed, []);
  });

  it("does not repeat the same failure Notice on automatic passes, but does on manual ones", async () => {
    const engine = engineFor();
    drive.listError = new PlumApiError(503, "x", "listing_incomplete");
    await engine.run();
    const n = notices().length;
    await engine.run();
    assert.equal(notices().length, n, "automatic repeat stays quiet");
    await engine.run({ manual: true });
    assert.equal(notices().length, n + 1, "manual sync always reports");
  });

  it("does not delete notes the box lists as remote: true", async () => {
    const engine = engineFor();
    await settled(engine, 3);
    drive.put(note(1), "note 1", { remote: true, noHash: true });
    drive.put(note(2), "note 2", { remote: true });
    const r = await engine.run();
    assert.ok(r);
    assert.equal(r.deletedLocal, 0);
    assert.ok(vault.has(note(1)) && vault.has(note(2)));
  });
});

describe("SyncEngine: mass-deletion guard", () => {
  it("applies deletions at or below the limit", async () => {
    const engine = engineFor();
    await settled(engine, 30); // limit = 10
    for (let i = 0; i < 10; i++) drive.drop(note(i));
    const r = await engine.run();
    assert.ok(r);
    assert.equal(r.deletedLocal, 10);
    assert.equal(vault.trashed.length, 10);
    assert.equal(plugin.prompts, 0);
  });

  it("holds local deletions above the limit, asks, and still syncs the rest", async () => {
    const engine = engineFor();
    await settled(engine, 30);
    for (let i = 0; i < 11; i++) drive.drop(note(i));
    vault.write("new.md", "fresh");
    const r = await engine.run();
    assert.ok(r);
    assert.equal(r.deletedLocal, 0);
    assert.equal(r.held.local.length, 11);
    assert.deepEqual(vault.trashed, []);
    assert.equal(plugin.prompts, 1, "the user is asked");
    assert.ok(drive.has("new.md"));
  });

  it("holds box deletions when the vault looks emptied (DS-04)", async () => {
    const engine = engineFor();
    await settled(engine, 30);
    vault.removeUnder("notes");
    const r = await engine.run();
    assert.ok(r);
    assert.equal(r.held.remote.length, 30);
    assert.deepEqual(drive.removed, []);
  });

  it("user chooses Delete: the next pass deletes exactly the held notes", async () => {
    const engine = engineFor();
    await settled(engine, 30);
    for (let i = 0; i < 12; i++) drive.drop(note(i));
    const r1 = await engine.run();
    assert.ok(r1);
    engine.decide("local", "delete", r1.held.local);
    const r2 = await engine.run();
    assert.ok(r2);
    assert.equal(r2.deletedLocal, 12);
    assert.equal(vault.trashed.length, 12);
    assert.ok(vault.has(note(12)));
  });

  it("user chooses Delete, but a held note was edited since: the edit is kept", async () => {
    const engine = engineFor();
    await settled(engine, 30);
    for (let i = 0; i < 12; i++) drive.drop(note(i));
    const r1 = await engine.run();
    assert.ok(r1);
    engine.decide("local", "delete", r1.held.local);
    vault.write(note(0), "edited after the prompt");
    const r2 = await engine.run();
    assert.ok(r2);
    assert.equal(r2.deletedLocal, 11);
    assert.equal(vault.read(note(0)), "edited after the prompt");
    assert.ok(drive.has(note(0)), "the edit is uploaded back");
  });

  it("a note edited while the pass runs is not trashed", async () => {
    const engine = engineFor();
    await settled(engine, 30);
    for (let i = 0; i < 12; i++) drive.drop(note(i));
    const r1 = await engine.run();
    assert.ok(r1);
    engine.decide("local", "delete", r1.held.local);
    // The edit lands after the vault was scanned, so the planner still sees
    // the old snapshot and plans the delete; the re-check before trashing
    // must catch it.
    drive.onList = () => vault.write(note(0), "edited mid-sync");
    const r2 = await engine.run();
    assert.ok(r2);
    assert.equal(r2.deletedLocal, 11);
    assert.equal(r2.skipped, 1);
    assert.equal(vault.read(note(0)), "edited mid-sync");
    const r3 = await engine.run();
    assert.ok(r3);
    assert.equal(r3.uploaded, 1, "the next pass uploads the edit");
    assert.ok(drive.has(note(0)));
  });

  it("user chooses Keep for notes missing on the box: they are re-uploaded", async () => {
    const engine = engineFor();
    await settled(engine, 30);
    for (let i = 0; i < 12; i++) drive.drop(note(i));
    const r1 = await engine.run();
    assert.ok(r1);
    engine.decide("local", "keep");
    const r2 = await engine.run();
    assert.ok(r2);
    assert.equal(r2.deletedLocal, 0);
    assert.equal(r2.uploaded, 12);
    assert.ok(drive.has(note(0)));
    const r3 = await engine.run();
    assert.ok(r3);
    assert.equal(r3.uploaded + r3.downloaded + r3.deletedLocal + r3.deletedRemote, 0);
  });

  it("user chooses Keep for notes missing here: they are re-downloaded", async () => {
    const engine = engineFor();
    await settled(engine, 30);
    vault.removeUnder("notes");
    const r1 = await engine.run();
    assert.ok(r1);
    engine.decide("remote", "keep", r1.held.remote);
    const r2 = await engine.run();
    assert.ok(r2);
    assert.equal(r2.downloaded, 30);
    assert.deepEqual(drive.removed, []);
    assert.equal(vault.read(note(29)), "note 29");
  });

  it("user chooses Delete for notes missing here: they go to the box trash", async () => {
    const engine = engineFor();
    await settled(engine, 30);
    vault.removeUnder("notes");
    const r1 = await engine.run();
    assert.ok(r1);
    engine.decide("remote", "delete", r1.held.remote);
    const r2 = await engine.run();
    assert.ok(r2);
    assert.equal(r2.deletedRemote, 30);
  });
});

describe("SyncEngine: things the vault cannot see are not deletions (DS-04)", () => {
  it("never deletes or downloads hidden box files", async () => {
    const engine = engineFor();
    drive.put(".obsidian/app.json", "{}");
    drive.put("sub/.git/config", "x");
    drive.put("a.md", "a");
    await engine.run();
    await engine.run();
    assert.deepEqual(drive.removed, []);
    assert.equal(vault.has(".obsidian/app.json"), false);
    assert.ok(vault.has("a.md"));
  });

  it("leaves an unreadable note alone instead of deleting it on the box", async () => {
    const engine = engineFor();
    await settled(engine, 3);
    vault.write(note(1), "changed, so it must be re-read");
    vault.failRead.add(note(1));
    const r = await engine.run();
    assert.ok(r);
    assert.equal(r.skipped, 1);
    assert.deepEqual(drive.removed, []);
    assert.equal(dec(drive.files.get(`${ROOT}/${note(1)}`)!.data), "note 1");
  });
});

describe("SyncEngine: base belongs to one account + remote folder (DS-02)", () => {
  it("changing the remote folder does not delete notes", async () => {
    const engine = engineFor();
    await settled(engine, 5);
    plugin.settings.remoteRoot = "/Obsidian/Elsewhere";
    const r = await engine.run();
    assert.ok(r);
    assert.equal(r.deletedLocal, 0);
    assert.deepEqual(vault.trashed, []);
  });

  it("switching to another account does not delete notes", async () => {
    const engine = engineFor();
    await settled(engine, 5);
    plugin.settings.account = "someone-else@example.com";
    drive.files.clear();
    const r = await engine.run();
    assert.ok(r);
    assert.equal(r.deletedLocal, 0);
    assert.equal(r.uploaded, 5);
  });

  it("adopts the key on upgrade without resetting the base", async () => {
    const engine = engineFor();
    await settled(engine, 5);
    plugin.settings.baseKey = "";
    await engine.run();
    assert.equal(Object.keys(plugin.settings.base).length, 5);
    assert.equal(plugin.settings.baseKey, syncTargetKey(plugin.settings));
  });
});

describe("SyncEngine: a save made during the pass is never lost (R3-MOB-003)", () => {
  it("a download does not overwrite a note saved while it was in flight; the next pass keeps both", async () => {
    const engine = engineFor();
    await settled(engine, 1);
    drive.put(note(0), "edited on the box");
    drive.onDownload = () => vault.write(note(0), "saved here while downloading");
    const r1 = await engine.run();
    assert.ok(r1);
    assert.equal(r1.downloaded, 0);
    assert.equal(r1.skipped, 1);
    assert.equal(vault.read(note(0)), "saved here while downloading");

    const r2 = await engine.run();
    assert.ok(r2);
    assert.equal(r2.conflicts, 1, "both sides changed: keep both");
    assert.equal(vault.read(note(0)), "saved here while downloading");
    assert.equal(boxText(note(0)), "saved here while downloading");
    const [copy] = conflictCopies();
    assert.ok(copy);
    assert.equal(vault.read(copy), "edited on the box");
  });

  it("a download does not overwrite a note created while it was in flight", async () => {
    const engine = engineFor();
    drive.put("new.md", "from the box");
    drive.onDownload = () => vault.write("new.md", "made here meanwhile");
    const r = await engine.run();
    assert.ok(r);
    assert.equal(r.downloaded, 0);
    assert.equal(vault.read("new.md"), "made here meanwhile");
  });

  it("a save made while its upload is in flight is uploaded on the next pass", async () => {
    const engine = engineFor();
    await settled(engine, 1);
    vault.write(note(0), "first edit");
    drive.onUpload = () => vault.write(note(0), "second edit, saved during the upload");
    const r1 = await engine.run();
    assert.ok(r1);
    assert.equal(r1.uploaded, 1);
    assert.equal(boxText(note(0)), "first edit");

    const r2 = await engine.run();
    assert.ok(r2);
    assert.equal(r2.uploaded, 1, "the second save is noticed, not hidden behind its own mtime");
    assert.equal(boxText(note(0)), "second edit, saved during the upload");

    drive.put(note(0), "box edit");
    const r3 = await engine.run();
    assert.ok(r3);
    assert.equal(r3.downloaded, 1);
    assert.equal(vault.read(note(0)), "box edit");
  });
});
