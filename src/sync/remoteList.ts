import type { DriveEntry, ListOptions } from "@plumbox/client";

/**
 * A listing entry as the box sends it. `remote: true` marks a file whose bytes
 * live on another RAID box in the pool — it exists, it just streams from a peer.
 * `secret: true` marks a locked folder whose contents the box never lists.
 */
export type RemoteEntry = DriveEntry & { remote?: boolean; secret?: boolean };

/** The sync pass stopped before changing anything. Shown to the user as-is. */
export class SyncAbortedError extends Error {
  constructor(message: string, readonly original?: unknown) {
    super(message);
    this.name = "SyncAbortedError";
  }
}

/** The box could not produce a complete listing of the sync folder. */
export class ListingIncompleteError extends SyncAbortedError {
  constructor(message: string, original?: unknown) {
    super(message, original);
    this.name = "ListingIncompleteError";
  }
}

/** One page of `GET /api/drive/list` (the SDK does not export its type). */
export interface ListPageLike {
  items: DriveEntry[];
  total: number;
}

export interface DriveLister {
  list(path: string, opts?: ListOptions): Promise<ListPageLike>;
}

const PAGE_SIZE = 1000; // the box's maximum page

function isListingIncomplete(e: unknown): boolean {
  const err = e as { status?: number; code?: string } | null;
  return !!err && err.status === 503 && err.code === "listing_incomplete";
}

/**
 * Read the whole tree under `root` and prove the result is complete.
 *
 * Everything missing from this listing is treated as "deleted on the box", so
 * a partial listing deletes real local files. This therefore never returns a
 * partial result:
 * - any non-2xx (in particular 503 `listing_incomplete`) throws — nothing here
 *   catches it into an empty list;
 * - the pages must agree on `total`, no page may come back empty early, and the
 *   distinct paths must add up to `total` (offset paging over a tree that
 *   changes between pages can skip entries). On a mismatch the listing is
 *   re-read; if it still does not add up, it throws.
 */
export async function listRemoteTree(
  drive: DriveLister,
  root: string,
  attempts = 3,
): Promise<RemoteEntry[]> {
  for (let attempt = 1; ; attempt++) {
    const got = await readOnce(drive, root);
    if (got) return got;
    if (attempt >= attempts) {
      throw new ListingIncompleteError(
        "Plum Box's file list kept changing while it was being read, so it may be incomplete. " +
          "Sync stopped before changing anything; it will try again.",
      );
    }
  }
}

async function readOnce(drive: DriveLister, root: string): Promise<RemoteEntry[] | null> {
  const seen = new Map<string, RemoteEntry>();
  let total: number | undefined;
  let offset = 0;
  for (;;) {
    let page: ListPageLike;
    try {
      page = await drive.list(root, { recursive: true, hash: true, limit: PAGE_SIZE, offset });
    } catch (e) {
      if (isListingIncomplete(e)) {
        throw new ListingIncompleteError(
          "Plum Box could not read every folder, so its file list is incomplete. " +
            "Sync stopped before changing anything — nothing was deleted. It will try again.",
          e,
        );
      }
      throw e;
    }
    if (!page || !Array.isArray(page.items) || typeof page.total !== "number") {
      throw new ListingIncompleteError(
        "Plum Box sent a file list this app does not understand. Sync stopped before changing anything.",
      );
    }
    if (total === undefined) total = page.total;
    else if (page.total !== total) return null; // tree changed between pages
    for (const item of page.items as RemoteEntry[]) seen.set(item.path, item);
    offset += page.items.length;
    if (offset >= total) break;
    if (page.items.length === 0) return null; // ran dry before `total`
  }
  return seen.size === total ? [...seen.values()] : null;
}
