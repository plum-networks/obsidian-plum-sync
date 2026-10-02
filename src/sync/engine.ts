import { Notice, TFile, normalizePath } from "obsidian";
import type { PlumClient } from "@plumbox/client";
import type PlumSyncPlugin from "../main.js";
import { buildClient } from "../plum.js";
import { sha256Hex, pool } from "./hash.js";
import { listRemoteTree, SyncAbortedError, type RemoteEntry } from "./remoteList.js";

export { ListingIncompleteError, SyncAbortedError } from "./remoteList.js";

type ActionKind = "upload" | "download" | "delLocal" | "delRemote" | "conflict";
interface Action {
  kind: ActionKind;
  rel: string;
}

export interface SyncResult {
  uploaded: number;
  downloaded: number;
  deletedLocal: number;
  deletedRemote: number;
  conflicts: number;
  errors: number;
}

// --- path helpers (vault paths are "/"-separated, no leading slash; drive
//     paths are absolute) -------------------------------------------------
function trimSlashes(s: string): string {
  return s.replace(/^\/+/, "").replace(/\/+$/, "");
}
function remotePathFor(root: string, rel: string): string {
  return "/" + trimSlashes(root) + "/" + trimSlashes(rel);
}
function relFromRemote(root: string, path: string): string | null {
  const r = trimSlashes(root);
  const p = trimSlashes(path);
  if (p === r) return null;
  if (!p.startsWith(r + "/")) return null;
  return p.slice(r.length + 1);
}
function parentOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i <= 0 ? "" : path.slice(0, i);
}
function conflictName(rel: string): string {
  const now = new Date();
  const stamp =
    `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}` +
    ` ${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}`;
  const dot = rel.lastIndexOf(".");
  const base = dot > rel.lastIndexOf("/") ? rel.slice(0, dot) : rel;
  const ext = dot > rel.lastIndexOf("/") ? rel.slice(dot) : "";
  return `${base} (conflict ${stamp})${ext}`;
}

export interface SyncEngineOptions {
  /** Defaults to the plugin's stored credentials. Tests inject a fake. */
  makeClient?: () => PlumClient | null;
}

export class SyncEngine {
  private running = false;
  /** Why the last pass stopped, or "" when it completed. */
  lastError = "";

  constructor(
    private plugin: PlumSyncPlugin,
    private opts: SyncEngineOptions = {},
  ) {}

  get isRunning(): boolean {
    return this.running;
  }

  /**
   * One sync pass. Never throws: a pass that cannot run safely (incomplete box
   * listing, network/auth failure) stops before changing anything, shows a
   * Notice and leaves `lastError` set. Returns null in that case.
   *
   * `manual`: the user asked for this pass, so always show its outcome. An
   * automatic pass does not repeat the Notice for the same failure.
   */
  async run(opts: { manual?: boolean } = {}): Promise<SyncResult | null> {
    if (this.running) {
      new Notice("Plum: a sync is already in progress.");
      return null;
    }
    const client = this.opts.makeClient ? this.opts.makeClient() : buildClient(this.plugin);
    if (!client) {
      new Notice("Plum: not connected. Open settings and Connect first.");
      return null;
    }
    this.running = true;
    try {
      const res = await this.pass(client);
      this.lastError = "";
      this.notifySummary(res);
      return res;
    } catch (e) {
      const msg = (e as Error)?.message || String(e);
      const repeat = msg === this.lastError;
      this.lastError = msg;
      console.error("plum-sync: sync stopped", e);
      if (opts.manual || !repeat) {
        new Notice(
          e instanceof SyncAbortedError ? `Plum: ${msg}` : `Plum: sync failed — ${msg}`,
          10000,
        );
      }
      return null;
    } finally {
      this.running = false;
    }
  }

  private async pass(client: PlumClient): Promise<SyncResult> {
    const root = this.plugin.settings.remoteRoot || this.defaultRoot();
    this.plugin.settings.remoteRoot = root;

    const res: SyncResult = {
      uploaded: 0,
      downloaded: 0,
      deletedLocal: 0,
      deletedRemote: 0,
      conflicts: 0,
      errors: 0,
    };
    await client.drive.ensureDir(root);

    // 1) enumerate both sides. The listing throws on any failed or
    //    incomplete answer (503 listing_incomplete, pages that don't add
    //    up) — nothing below runs on a partial view of the box.
    const localFiles = new Map<string, TFile>();
    for (const f of this.plugin.app.vault.getFiles()) {
      localFiles.set(f.path, f);
    }
    const entries = await listRemoteTree(client.drive, root);
    const remote = new Map<string, RemoteEntry>();
    for (const e of entries) {
      if (e.isDir) continue;
      const rel = relFromRemote(root, e.path);
      if (rel) remote.set(rel, e); // `remote: true` (peer-held) is present like any file
    }

    // 2) local hashes (reuse the base snapshot when mtime is unchanged)
    const base = this.plugin.settings.base;
    const localHash = new Map<string, string>();
    for (const [rel, f] of localFiles) {
      const snap = base[rel];
      if (snap && snap.mtime === f.stat.mtime) {
        localHash.set(rel, snap.hash);
      } else {
        const buf = await this.plugin.app.vault.adapter.readBinary(f.path);
        localHash.set(rel, await sha256Hex(buf));
      }
    }

    // 3) 3-way classification
    const actions: Action[] = [];
    const allRels = new Set<string>([...localFiles.keys(), ...remote.keys()]);
    for (const rel of allRels) {
      const L = localHash.has(rel);
      const R = remote.has(rel);
      const B = base[rel]?.hash;
      const lh = localHash.get(rel);
      const rh = remote.get(rel)?.hash; // may be undefined for legacy remote files

      if (L && !R) {
        actions.push({ kind: B ? "delLocal" : "upload", rel });
      } else if (!L && R) {
        actions.push({ kind: B ? "delRemote" : "download", rel });
      } else if (L && R) {
        if (rh !== undefined && lh === rh) continue; // identical → noop
        const localChanged = lh !== B;
        const remoteChanged = rh === undefined ? true : rh !== B;
        if (localChanged && !remoteChanged) actions.push({ kind: "upload", rel });
        else if (!localChanged && remoteChanged) actions.push({ kind: "download", rel });
        else actions.push({ kind: "conflict", rel });
      }
    }

    // 4) execute
    await pool(actions, 4, async (a) => {
      try {
        await this.exec(a, client, root, localHash);
        this.tally(res, a.kind);
      } catch (e) {
        res.errors++;
        console.error(`plum-sync: ${a.kind} ${a.rel} failed`, e);
      }
    });

    this.plugin.settings.lastSync = Date.now();
    await this.plugin.saveSettings();
    return res;
  }

  private tally(res: SyncResult, kind: ActionKind): void {
    if (kind === "upload") res.uploaded++;
    else if (kind === "download") res.downloaded++;
    else if (kind === "delLocal") res.deletedLocal++;
    else if (kind === "delRemote") res.deletedRemote++;
    else if (kind === "conflict") res.conflicts++;
  }

  private async exec(
    a: Action,
    client: PlumClient,
    root: string,
    localHash: Map<string, string>,
  ): Promise<void> {
    const base = this.plugin.settings.base;
    const remotePath = remotePathFor(root, a.rel);
    const vault = this.plugin.app.vault;

    if (a.kind === "upload") {
      const buf = await vault.adapter.readBinary(a.rel);
      const dir = parentOf(remotePath);
      if (dir) await client.drive.ensureDir(dir);
      await client.drive.upload(remotePath, buf, { overwrite: true });
      base[a.rel] = { hash: localHash.get(a.rel)!, mtime: (await this.mtime(a.rel)) ?? Date.now() };
    } else if (a.kind === "download") {
      const buf = await client.drive.download(remotePath);
      await this.writeLocal(a.rel, buf);
      base[a.rel] = { hash: await sha256Hex(buf), mtime: (await this.mtime(a.rel)) ?? Date.now() };
    } else if (a.kind === "delLocal") {
      const f = vault.getAbstractFileByPath(a.rel);
      if (f instanceof TFile) await vault.trash(f, false); // → vault .trash, recoverable
      delete base[a.rel];
    } else if (a.kind === "delRemote") {
      await client.drive.remove(remotePath); // → box trash, recoverable
      delete base[a.rel];
    } else if (a.kind === "conflict") {
      // Keep both: pull the remote copy to a conflict-named local file, and push
      // our local version to the canonical path. Neither side loses data; the
      // conflict copy propagates on the next sync.
      const remoteBuf = await client.drive.download(remotePath);
      const cRel = conflictName(a.rel);
      await this.writeLocal(cRel, remoteBuf);
      base[cRel] = { hash: await sha256Hex(remoteBuf), mtime: (await this.mtime(cRel)) ?? Date.now() };

      const localBuf = await vault.adapter.readBinary(a.rel);
      await client.drive.upload(remotePath, localBuf, { overwrite: true });
      base[a.rel] = { hash: localHash.get(a.rel)!, mtime: (await this.mtime(a.rel)) ?? Date.now() };
      new Notice(`Plum: conflict on "${a.rel}" — kept both copies.`);
    }
  }

  private async writeLocal(rel: string, buf: ArrayBuffer): Promise<void> {
    const dir = parentOf(rel);
    if (dir) await this.ensureLocalDir(dir);
    await this.plugin.app.vault.adapter.writeBinary(rel, buf);
  }

  private async ensureLocalDir(dir: string): Promise<void> {
    const parts = normalizePath(dir).split("/").filter(Boolean);
    let cur = "";
    for (const seg of parts) {
      cur = cur ? `${cur}/${seg}` : seg;
      if (!(await this.plugin.app.vault.adapter.exists(cur))) {
        try {
          await this.plugin.app.vault.createFolder(cur);
        } catch {
          /* raced / already exists */
        }
      }
    }
  }

  private async mtime(rel: string): Promise<number | null> {
    const f = this.plugin.app.vault.getAbstractFileByPath(rel);
    return f instanceof TFile ? f.stat.mtime : null;
  }

  private notifySummary(r: SyncResult): void {
    const parts: string[] = [];
    if (r.uploaded) parts.push(`↑${r.uploaded}`);
    if (r.downloaded) parts.push(`↓${r.downloaded}`);
    if (r.deletedRemote) parts.push(`🗑remote ${r.deletedRemote}`);
    if (r.deletedLocal) parts.push(`🗑local ${r.deletedLocal}`);
    if (r.conflicts) parts.push(`⚠${r.conflicts} conflict`);
    if (r.errors) parts.push(`✗${r.errors} error`);
    new Notice(`Plum sync: ${parts.length ? parts.join("  ") : "already up to date"}`);
  }

  defaultRoot(): string {
    return `/Obsidian/${this.plugin.app.vault.getName()}`;
  }
}
