import { Notice, TFile, normalizePath } from "obsidian";
import type { PlumClient } from "@plumbox/client";
import type PlumSyncPlugin from "../main.js";
import type { FileSnapshot } from "../types.js";
import { buildClient } from "../plum.js";
import { sha256Hex, pool } from "./hash.js";
import {
  guardDeletions,
  isUnder,
  planSync,
  type Action,
  type ActionKind,
  type DeletionGuardConfig,
  type DeletionSide,
  type HeldDeletions,
} from "./plan.js";
import { listRemoteTree, SyncAbortedError, type RemoteEntry } from "./remoteList.js";

export { ListingIncompleteError, SyncAbortedError } from "./remoteList.js";
export type { DeletionSide, HeldDeletions } from "./plan.js";

export interface SyncResult {
  uploaded: number;
  downloaded: number;
  deletedLocal: number;
  deletedRemote: number;
  conflicts: number;
  errors: number;
  /** Paths left alone this pass: unreadable, or edited while it ran. */
  skipped: number;
  /**
   * Deletions withheld by the mass-deletion guard, waiting for the user:
   * `local` would delete notes in this vault (missing on the box),
   * `remote` would delete files on the box (missing in this vault).
   */
  held: HeldDeletions;
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

/**
 * Obsidian does not index dot-files/folders (.obsidian, .trash, .git), so the
 * vault can never "see" them. A box file under such a path would be downloaded
 * and then look deleted on the next pass — so both sides skip them.
 */
export function isHiddenRel(rel: string): boolean {
  return rel.split("/").some((seg) => seg.startsWith("."));
}

/**
 * Identity of what a base describes: box + account + remote folder (the vault
 * itself is implied — the plugin's data lives inside it). See `baseKey`.
 */
export function syncTargetKey(s: { baseUrl: string; account: string; remoteRoot: string }): string {
  return JSON.stringify([
    (s.baseUrl || "").trim().replace(/\/+$/, "").toLowerCase(),
    (s.account || "").trim().toLowerCase(),
    "/" + trimSlashes(s.remoteRoot || ""),
  ]);
}

type PerSide<T> = { local: T; remote: T };
const emptySets = (): PerSide<Set<string>> => ({ local: new Set(), remote: new Set() });

export interface SyncEngineOptions {
  /** Defaults to the plugin's stored credentials. Tests inject a fake. */
  makeClient?: () => PlumClient | null;
  /** Mass-deletion guard thresholds; defaults to DEFAULT_DELETION_GUARD. */
  deletionGuard?: DeletionGuardConfig;
}

export class SyncEngine {
  private running = false;
  /** Deletions the guard withheld on the last pass, awaiting the user. */
  private held: HeldDeletions = { local: [], remote: [] };
  /** User said "delete": these may be deleted on the next pass. */
  private approved = emptySets();
  /** User said "keep": forget their base on the next pass. */
  private keep = emptySets();
  /** Why the last pass stopped, or "" when it completed. */
  lastError = "";

  constructor(
    private plugin: PlumSyncPlugin,
    private opts: SyncEngineOptions = {},
  ) {}

  get isRunning(): boolean {
    return this.running;
  }

  get heldDeletions(): HeldDeletions {
    return { local: [...this.held.local], remote: [...this.held.remote] };
  }

  /**
   * Record the user's answer for deletions the guard held back. It takes
   * effect at the start of the next pass, never mid-pass, so that pass
   * re-checks everything first.
   *
   * - "delete": the next pass may delete exactly these paths — and only if it
   *   still plans to (a file edited since is kept).
   * - "keep": their base entries are dropped, so the side that still has the
   *   file wins: missing on the box → re-uploaded, missing here → re-downloaded.
   *   Nothing is deleted.
   */
  decide(side: DeletionSide, choice: "delete" | "keep", rels: string[] = this.held[side]): void {
    const target = choice === "delete" ? this.approved[side] : this.keep[side];
    for (const r of rels) target.add(r);
    const done = new Set(rels);
    this.held[side] = this.held[side].filter((r) => !done.has(r));
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
      if (res.held.local.length || res.held.remote.length) {
        this.plugin.promptHeldDeletions?.(false);
      }
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
    const settings = this.plugin.settings;
    const root = settings.remoteRoot || this.defaultRoot();
    settings.remoteRoot = root;
    this.bindBase();

    const res: SyncResult = {
      uploaded: 0,
      downloaded: 0,
      deletedLocal: 0,
      deletedRemote: 0,
      conflicts: 0,
      errors: 0,
      skipped: 0,
      held: { local: [], remote: [] },
    };
    const vault = this.plugin.app.vault;
    const configDir = vault.configDir || ".obsidian";
    const ignored = (rel: string): boolean => isHiddenRel(rel) || isUnder(rel, configDir);

    await client.drive.ensureDir(root);

    // 1) enumerate both sides. The listing throws on any failed or incomplete
    //    answer (503 listing_incomplete, pages that don't add up) — nothing
    //    below runs on a partial view of the box. TFile objects are live (stat
    //    updates in place), so remember each note's mtime as it was seen.
    const localFiles = new Map<string, TFile>();
    const seenMtime = new Map<string, number>();
    for (const f of vault.getFiles()) {
      if (ignored(f.path)) continue;
      localFiles.set(f.path, f);
      seenMtime.set(f.path, f.stat.mtime);
    }
    const entries = await listRemoteTree(client.drive, root);
    const opaque: string[] = []; // paths whose contents we cannot see this pass
    const remote = new Map<string, RemoteEntry>();
    for (const e of entries) {
      const rel = relFromRemote(root, e.path);
      if (!rel || ignored(rel)) continue;
      if (e.isDir) {
        if (e.secret) opaque.push(rel); // locked folder: contents never listed
        continue;
      }
      remote.set(rel, e); // `remote: true` (peer-held) is present like any file
    }

    // 2) local hashes (reuse the base snapshot when mtime is unchanged). A note
    //    that cannot be read is left alone, not treated as deleted.
    const base = settings.base;
    this.applyKeep(base);
    const localHash = new Map<string, string>();
    for (const [rel, f] of localFiles) {
      const snap = base[rel];
      if (snap && snap.mtime === seenMtime.get(rel)) {
        localHash.set(rel, snap.hash);
        continue;
      }
      try {
        const buf = await vault.adapter.readBinary(f.path);
        localHash.set(rel, await sha256Hex(buf));
      } catch (e) {
        console.error(`plum-sync: could not read ${rel}; leaving it alone this pass`, e);
        opaque.push(rel);
      }
    }
    res.skipped = opaque.length;

    // 3) 3-way classification + mass-deletion guard
    const planned = planSync({
      local: localHash,
      remote,
      base,
      skip: (rel) => ignored(rel) || opaque.some((p) => isUnder(rel, p)),
    });
    const guarded = guardDeletions(
      planned,
      Object.keys(base).length,
      this.approved,
      this.opts.deletionGuard,
    );
    this.approved = emptySets();
    this.held = guarded.held;
    res.held = this.heldDeletions;

    // 4) execute
    await pool(guarded.run, 4, async (a) => {
      try {
        const done = await this.exec(a, client, root, localHash, seenMtime);
        if (done) this.tally(res, a.kind);
        else res.skipped++;
      } catch (e) {
        res.errors++;
        console.error(`plum-sync: ${a.kind} ${a.rel} failed`, e);
      }
    });

    settings.lastSync = Date.now();
    await this.plugin.saveSettings();
    return res;
  }

  /**
   * DS-02: a base is only valid for the account + remote folder it was
   * recorded against. When either changed, start from an empty base: that
   * pass can only upload, download or keep both — it cannot delete.
   */
  private bindBase(): void {
    const settings = this.plugin.settings;
    const key = syncTargetKey(settings);
    if (settings.baseKey === key) return;
    if (settings.baseKey && Object.keys(settings.base).length) {
      console.info("plum-sync: account or remote folder changed — starting from a fresh base");
      settings.base = {};
    }
    settings.baseKey = key;
    this.held = { local: [], remote: [] };
    this.approved = emptySets();
    this.keep = emptySets();
  }

  private applyKeep(base: Record<string, unknown>): void {
    for (const side of ["local", "remote"] as const) {
      for (const rel of this.keep[side]) delete base[rel];
    }
    this.keep = emptySets();
  }

  private tally(res: SyncResult, kind: ActionKind): void {
    if (kind === "upload") res.uploaded++;
    else if (kind === "download") res.downloaded++;
    else if (kind === "delLocal") res.deletedLocal++;
    else if (kind === "delRemote") res.deletedRemote++;
    else if (kind === "conflict") res.conflicts++;
  }

  /** Returns false when the action was deliberately not carried out. */
  private async exec(
    a: Action,
    client: PlumClient,
    root: string,
    localHash: Map<string, string>,
    seenMtime: Map<string, number>,
  ): Promise<boolean> {
    const base = this.plugin.settings.base;
    const remotePath = remotePathFor(root, a.rel);
    const vault = this.plugin.app.vault;

    if (a.kind === "adopt") {
      base[a.rel] = { hash: localHash.get(a.rel)!, mtime: seenMtime.get(a.rel) ?? Date.now() };
    } else if (a.kind === "forget") {
      delete base[a.rel];
    } else if (a.kind === "upload") {
      const sent = await this.readForUpload(a.rel);
      const dir = parentOf(remotePath);
      if (dir) await client.drive.ensureDir(dir);
      await client.drive.upload(remotePath, sent.buf, { overwrite: true });
      base[a.rel] = sent.snapshot;
    } else if (a.kind === "download") {
      const buf = await client.drive.download(remotePath);
      // R3-MOB-003: the note may have been saved (or created) while the
      // download was in flight. Never overwrite that — leave it; the next pass
      // sees both sides changed and keeps both copies.
      const wrote = await this.writeLocal(a.rel, buf, () => this.asScanned(a.rel, seenMtime.get(a.rel)));
      if (!wrote) return false;
      base[a.rel] = { hash: await sha256Hex(buf), mtime: (await this.mtime(a.rel)) ?? Date.now() };
    } else if (a.kind === "delLocal") {
      const f = vault.getAbstractFileByPath(a.rel);
      if (f instanceof TFile) {
        // DS-07: the note may have been edited since it was hashed. An edit
        // beats a delete — leave it; the next pass uploads it.
        const seen = seenMtime.get(a.rel);
        if (seen !== undefined && f.stat.mtime !== seen) return false;
        await vault.trash(f, false); // → vault .trash, recoverable
      }
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

      const sent = await this.readForUpload(a.rel);
      await client.drive.upload(remotePath, sent.buf, { overwrite: true });
      base[a.rel] = sent.snapshot;
      new Notice(`Plum: conflict on "${a.rel}" — kept both copies.`);
    }
    return true;
  }

  /**
   * Write `buf` to `rel`. With `stillAsScanned`, it is asked after the folders
   * exist and right before the write; false → nothing is written.
   */
  private async writeLocal(
    rel: string,
    buf: ArrayBuffer,
    stillAsScanned?: () => Promise<boolean>,
  ): Promise<boolean> {
    const dir = parentOf(rel);
    if (dir) await this.ensureLocalDir(dir);
    if (stillAsScanned && !(await stillAsScanned())) return false;
    await this.plugin.app.vault.adapter.writeBinary(rel, buf);
    return true;
  }

  /**
   * True when `rel` is still what the scan saw: the same mtime (Obsidian's
   * TFile stat is live), or — `seen` undefined — still nothing at all.
   */
  private async asScanned(rel: string, seen: number | undefined): Promise<boolean> {
    const vault = this.plugin.app.vault;
    const f = vault.getAbstractFileByPath(rel);
    if (seen === undefined) return f === null && !(await vault.adapter.exists(rel));
    return f instanceof TFile && f.stat.mtime === seen;
  }

  /**
   * Read a note for upload, with the base entry it earns once uploaded: the
   * hash of exactly these bytes and the mtime from BEFORE reading them. A save
   * that lands while the upload is in flight then has a newer mtime than the
   * base, so the next pass re-hashes and uploads it. (Taking the mtime after
   * the upload paired the new mtime with the old hash, and the save was never
   * synced — until a box edit overwrote it.)
   */
  private async readForUpload(rel: string): Promise<{ buf: ArrayBuffer; snapshot: FileSnapshot }> {
    const mtime = (await this.mtime(rel)) ?? 0;
    const buf = await this.plugin.app.vault.adapter.readBinary(rel);
    return { buf, snapshot: { hash: await sha256Hex(buf), mtime } };
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
    if (r.skipped) parts.push(`${r.skipped} skipped`);
    const held = r.held.local.length + r.held.remote.length;
    if (held) parts.push(`⏸${held} deletions paused`);
    new Notice(`Plum sync: ${parts.length ? parts.join("  ") : "already up to date"}`);
  }

  defaultRoot(): string {
    return `/Obsidian/${this.plugin.app.vault.getName()}`;
  }
}
