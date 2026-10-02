import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  deletionLimit,
  guardDeletions,
  planSync,
  type Action,
  type RemoteFileState,
} from "../src/sync/plan.js";

const kinds = (actions: Action[]): Record<string, string> =>
  Object.fromEntries(actions.map((a) => [a.rel, a.kind]));

describe("planSync", () => {
  it("propagates deletions against the base", () => {
    const actions = planSync({
      local: new Map([["here.txt", "h1"]]),
      remote: new Map<string, RemoteFileState>([["there.txt", { hash: "h2" }]]),
      base: { "here.txt": { hash: "h1" }, "there.txt": { hash: "h2" } },
    });
    assert.deepEqual(kinds(actions), { "here.txt": "delLocal", "there.txt": "delRemote" });
  });

  it("treats remote: true (peer-held) entries as present — never a local deletion", () => {
    const actions = planSync({
      local: new Map([
        ["peer.bin", "h1"],
        ["peer-nohash.bin", "h2"],
      ]),
      remote: new Map<string, RemoteFileState>([
        ["peer.bin", { hash: "h1", remote: true }],
        ["peer-nohash.bin", { remote: true }],
        ["peer-new.bin", { hash: "h3", remote: true }],
      ]),
      base: { "peer.bin": { hash: "h1" }, "peer-nohash.bin": { hash: "h2" } },
    });
    const k = kinds(actions);
    assert.equal(k["peer.bin"], undefined, "identical → no action");
    assert.equal(k["peer-nohash.bin"], "download", "no hash → downloaded like any unhashed file");
    assert.equal(k["peer-new.bin"], "download");
    assert.ok(!actions.some((a) => a.kind === "delLocal"));
  });

  it("adopts identical files with no base and forgets files gone on both sides", () => {
    const actions = planSync({
      local: new Map([["a.txt", "h1"]]),
      remote: new Map<string, RemoteFileState>([["a.txt", { hash: "h1" }]]),
      base: { "gone.txt": { hash: "h9" } },
    });
    assert.deepEqual(kinds(actions), { "a.txt": "adopt", "gone.txt": "forget" });
  });
});

describe("deletionLimit", () => {
  it("is min(50, 10% of base) but never below 10", () => {
    assert.equal(deletionLimit(0), 10);
    assert.equal(deletionLimit(50), 10);
    assert.equal(deletionLimit(200), 20);
    assert.equal(deletionLimit(500), 50);
    assert.equal(deletionLimit(10_000), 50);
  });
});

describe("guardDeletions", () => {
  const dels = (kind: "delLocal" | "delRemote", n: number): Action[] =>
    Array.from({ length: n }, (_, i) => ({ kind, rel: `f${String(i).padStart(3, "0")}` }));

  it("lets deletions through at or below the limit", () => {
    const actions = [...dels("delLocal", 20), { kind: "upload" as const, rel: "new.txt" }];
    const g = guardDeletions(actions, 200); // limit 20
    assert.equal(g.limit, 20);
    assert.deepEqual(g.held, { local: [], remote: [] });
    assert.equal(g.run.length, 21);
  });

  it("holds every deletion on a side above the limit and keeps the rest of the pass", () => {
    const actions = [...dels("delLocal", 21), { kind: "upload" as const, rel: "new.txt" }];
    const g = guardDeletions(actions, 200);
    assert.equal(g.held.local.length, 21);
    assert.deepEqual(g.held.remote, []);
    assert.deepEqual(g.run, [{ kind: "upload", rel: "new.txt" }]);
  });

  it("guards each side on its own", () => {
    const actions = [...dels("delLocal", 5), ...dels("delRemote", 60)];
    const g = guardDeletions(actions, 1000); // limit 50
    assert.deepEqual(g.held.local, []);
    assert.equal(g.held.remote.length, 60);
    assert.equal(g.run.filter((a) => a.kind === "delLocal").length, 5);
    assert.equal(g.run.filter((a) => a.kind === "delRemote").length, 0);
  });

  it("lets approved deletions through without counting them", () => {
    const actions = dels("delRemote", 60);
    const approved = { local: new Set<string>(), remote: new Set(actions.map((a) => a.rel)) };
    const g = guardDeletions(actions, 1000, approved);
    assert.deepEqual(g.held, { local: [], remote: [] });
    assert.equal(g.run.length, 60);
  });

  it("caps at 50 even for a very large base", () => {
    assert.equal(guardDeletions(dels("delLocal", 51), 100_000).held.local.length, 51);
    assert.equal(guardDeletions(dels("delLocal", 50), 100_000).held.local.length, 0);
  });
});
