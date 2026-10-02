import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PlumApiError, type DriveEntry, type ListOptions } from "@plumbox/client";
import {
  ListingIncompleteError,
  listRemoteTree,
  type ListPageLike,
} from "../src/sync/remoteList.js";

const entry = (path: string): DriveEntry => ({
  name: path.slice(path.lastIndexOf("/") + 1),
  path,
  isDir: false,
  size: 1,
  modTime: "2026-01-01T00:00:00Z",
});

/** Serves `pages` in order, one per list() call (offset ignored). */
function scripted(pages: Array<ListPageLike | Error>) {
  let i = 0;
  return {
    calls: () => i,
    list: async (_p: string, _o?: ListOptions): Promise<ListPageLike> => {
      const next = pages[Math.min(i++, pages.length - 1)]!;
      if (next instanceof Error) throw next;
      return next;
    },
  };
}

describe("listRemoteTree", () => {
  it("returns every entry of a consistent multi-page listing", async () => {
    const a = Array.from({ length: 1000 }, (_, i) => entry(`/R/a${i}`));
    const b = [entry("/R/b0"), entry("/R/b1")];
    const d = scripted([
      { items: a, total: 1002 },
      { items: b, total: 1002 },
    ]);
    const got = await listRemoteTree(d, "/R");
    assert.equal(got.length, 1002);
  });

  it("throws ListingIncompleteError on 503 listing_incomplete (never an empty list)", async () => {
    const d = scripted([
      new PlumApiError(503, "Some folders could not be read", "listing_incomplete"),
    ]);
    await assert.rejects(listRemoteTree(d, "/R"), ListingIncompleteError);
  });

  it("propagates any other listing error unchanged", async () => {
    const boom = new PlumApiError(500, "disk on fire");
    await assert.rejects(listRemoteTree(scripted([boom]), "/R"), (e) => e === boom);
  });

  it("re-reads when total changes between pages, then gives up", async () => {
    const page1 = { items: Array.from({ length: 1000 }, (_, i) => entry(`/R/a${i}`)), total: 1001 };
    const page2 = { items: [entry("/R/z")], total: 1002 };
    const d = scripted([page1, page2, page1, page2, page1, page2]);
    await assert.rejects(listRemoteTree(d, "/R"), ListingIncompleteError);
    assert.equal(d.calls(), 6);
  });

  it("rejects a listing that runs dry before total", async () => {
    const d = scripted([{ items: [entry("/R/a")], total: 5 }, { items: [], total: 5 }]);
    await assert.rejects(listRemoteTree(d, "/R", 1), ListingIncompleteError);
  });

  it("rejects pages that repeat entries instead of covering the tree", async () => {
    const first = Array.from({ length: 1000 }, (_, i) => entry(`/R/a${i}`));
    // Second page overlaps the first: 1001 items read, 1000 distinct paths.
    const d = scripted([
      { items: first, total: 1001 },
      { items: [entry("/R/a999")], total: 1001 },
    ]);
    await assert.rejects(listRemoteTree(d, "/R", 1), ListingIncompleteError);
  });

  it("recovers when a re-read is consistent", async () => {
    const d = scripted([
      { items: [entry("/R/a")], total: 3 },
      { items: [], total: 3 },
      { items: [entry("/R/a"), entry("/R/b"), entry("/R/c")], total: 3 },
    ]);
    assert.equal((await listRemoteTree(d, "/R")).length, 3);
  });

  it("rejects a malformed page", async () => {
    const d = scripted([{ nope: true } as unknown as ListPageLike]);
    await assert.rejects(listRemoteTree(d, "/R"), ListingIncompleteError);
  });
});
