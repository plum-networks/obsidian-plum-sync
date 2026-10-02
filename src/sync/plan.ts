// Pure sync planning: the 3-way decision and the mass-deletion guard.
// No I/O and no Electron here, so every rule that can delete a file is unit
// tested (test/plan.test.ts).

export type ActionKind =
  | "upload"
  | "download"
  | "delLocal"
  | "delRemote"
  | "conflict"
  /** Both sides already hold the same bytes: record them as the base. */
  | "adopt"
  /** Gone on both sides: drop the stale base entry. */
  | "forget";

export interface Action {
  kind: ActionKind;
  rel: string;
}

/** What the planner needs from a remote listing entry. */
export interface RemoteFileState {
  /** SHA-256 when the box has indexed the file; absent (or "") otherwise. */
  hash?: string;
  /**
   * Bytes held by another RAID box in the same pool. Still a file that exists:
   * it is never a reason to delete the local copy.
   */
  remote?: boolean;
}

export interface PlanInput {
  /** rel → SHA-256 of every local file that could be read this pass. */
  local: ReadonlyMap<string, string>;
  /** rel → entry for every remote file in a COMPLETE listing. */
  remote: ReadonlyMap<string, RemoteFileState>;
  /** Last-sync base: rel → hash both sides agreed on. */
  base: Readonly<Record<string, { hash: string }>>;
}

/**
 * 3-way classification against the last-sync base.
 *
 * Deletion propagates only when the surviving side is exactly what we last
 * synced. A file edited on one side and deleted on the other keeps the edit
 * (it is re-uploaded / re-downloaded) — an edit always beats a delete.
 */
export function planSync(input: PlanInput): Action[] {
  const { local, remote, base } = input;
  const out: Action[] = [];
  const rels = new Set<string>([...local.keys(), ...remote.keys(), ...Object.keys(base)]);

  for (const rel of rels) {
    const lh = local.get(rel);
    const r = remote.get(rel);
    const L = lh !== undefined;
    const R = r !== undefined;
    const B = base[rel]?.hash;
    const rh = r?.hash ? r.hash : undefined; // "" / missing → unknown

    if (L && !R) {
      if (B === undefined) out.push({ kind: "upload", rel });
      else if (lh === B) out.push({ kind: "delLocal", rel });
      else out.push({ kind: "upload", rel }); // edited here since last sync
    } else if (!L && R) {
      if (B === undefined) out.push({ kind: "download", rel });
      else if (rh !== undefined && rh !== B) out.push({ kind: "download", rel }); // edited on the box
      else out.push({ kind: "delRemote", rel });
    } else if (L && R) {
      if (rh !== undefined && lh === rh) {
        if (B !== lh) out.push({ kind: "adopt", rel });
        continue;
      }
      const localChanged = lh !== B;
      const remoteChanged = rh === undefined ? true : rh !== B;
      if (localChanged && !remoteChanged) out.push({ kind: "upload", rel });
      else if (!localChanged && remoteChanged) out.push({ kind: "download", rel });
      else out.push({ kind: "conflict", rel });
    } else if (B !== undefined) {
      out.push({ kind: "forget", rel });
    }
  }
  return out;
}

// --- mass-deletion guard ---------------------------------------------------

/**
 * Which side a held deletion would hit:
 * - "local":  files missing on the box → would be deleted on this computer
 * - "remote": files missing on this computer → would be deleted on the box
 */
export type DeletionSide = "local" | "remote";

export interface DeletionGuardConfig {
  /** Never delete more than this many files on one side without asking… */
  maxFiles: number;
  /** …or more than this fraction of the last-sync base… */
  maxRatio: number;
  /** …but always allow at least this many (small folders stay frictionless). */
  minFiles: number;
}

export const DEFAULT_DELETION_GUARD: DeletionGuardConfig = {
  maxFiles: 50,
  maxRatio: 0.1,
  minFiles: 10,
};

/**
 * Largest number of deletions one side may take in a single pass without
 * asking: min(50, 10% of the base), but never below 10.
 */
export function deletionLimit(
  baselineCount: number,
  cfg: DeletionGuardConfig = DEFAULT_DELETION_GUARD,
): number {
  return Math.max(cfg.minFiles, Math.min(cfg.maxFiles, baselineCount * cfg.maxRatio));
}

export interface HeldDeletions {
  local: string[];
  remote: string[];
}

export interface ApprovedDeletions {
  local: ReadonlySet<string>;
  remote: ReadonlySet<string>;
}

export interface GuardResult {
  /** Actions to execute now. */
  run: Action[];
  /** Deletions withheld until the user decides. */
  held: HeldDeletions;
  limit: number;
}

const DELETE_KIND: Record<DeletionSide, ActionKind> = {
  local: "delLocal",
  remote: "delRemote",
};

/**
 * Hold back every deletion on a side when that side would lose more files
 * than {@link deletionLimit} in one pass. A wiped, moved or half-listed folder
 * looks exactly like "the user deleted everything"; past the limit we ask.
 * Deletions the user already approved pass through and do not count.
 */
export function guardDeletions(
  actions: Action[],
  baselineCount: number,
  approved: ApprovedDeletions = { local: new Set(), remote: new Set() },
  cfg: DeletionGuardConfig = DEFAULT_DELETION_GUARD,
): GuardResult {
  const limit = deletionLimit(baselineCount, cfg);
  const held: HeldDeletions = { local: [], remote: [] };
  const holdKeys = new Set<string>();

  for (const side of ["local", "remote"] as const) {
    const kind = DELETE_KIND[side];
    const pending = actions.filter((a) => a.kind === kind && !approved[side].has(a.rel));
    if (pending.length > limit) {
      held[side] = pending.map((a) => a.rel).sort();
      for (const a of pending) holdKeys.add(`${kind}\0${a.rel}`);
    }
  }

  const run = holdKeys.size
    ? actions.filter((a) => !holdKeys.has(`${a.kind}\0${a.rel}`))
    : actions;
  return { run, held, limit };
}
