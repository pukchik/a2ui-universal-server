import { expect, it } from "vitest";
import {
  mkdtemp,
  mkdir,
  writeFile,
  utimes,
  symlink,
  readFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import {
  planRuntimeCleanup,
  purgeRuntime,
} from "../server/adapters/codex/runtime.ts";

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), "a2ui-runtime-test-"));
  const runtimeDir = join(base, "runtime");
  const profileDir = join(base, "profile");
  await mkdir(runtimeDir);
  await mkdir(profileDir);
  const options = { runtimeDir, profileDir, retentionDays: 1 };
  const old = new Date(Date.now() - 3 * 86400000);
  async function marker(name: string, value: unknown, aged = true) {
    const path = join(runtimeDir, name);
    await mkdir(path);
    const file = join(path, "process.json");
    await writeFile(file, JSON.stringify(value));
    if (aged) await utimes(file, old, old);
    return path;
  }
  return { ...options, options, old, marker, base };
}

it("plans only old completed runs, without changing files or following symlinks", async () => {
  const f = await fixture();
  const eligible = await f.marker("run-aaaaaa", { done: true });
  await f.marker("run-bbbbbb", { done: false });
  await f.marker("run-cccccc", { done: true }, false);
  await f.marker("unrelated", { done: true });
  await f.marker("run-short", { done: true });
  const external = join(f.profileDir, "process.json");
  await writeFile(external, '{"done":true}');
  await utimes(external, f.old, f.old);
  await symlink(f.profileDir, join(f.runtimeDir, "run-dddddd"));
  const linkedMarker = join(f.runtimeDir, "run-eeeeee");
  await mkdir(linkedMarker);
  await symlink(external, join(linkedMarker, "process.json"));
  await f.marker("run-ffffff", { done: true, padding: "x".repeat(1100) });
  const malformed = await f.marker("run-gggggg", {});
  await writeFile(join(malformed, "process.json"), "broken");
  await utimes(join(malformed, "process.json"), f.old, f.old);
  expect(await planRuntimeCleanup(f.options)).toEqual([eligible]);
  expect(
    JSON.parse(await readFile(join(eligible, "process.json"), "utf8")),
  ).toEqual({ done: true });
  expect(await readFile(external, "utf8")).toBe('{"done":true}');
});

it("rejects profile overlap, broad roots and symlinked runtime paths", async () => {
  const f = await fixture();
  for (const runtimeDir of [
    "/",
    tmpdir(),
    homedir(),
    f.profileDir,
    join(f.profileDir, "child"),
    f.base,
    join(f.profileDir, "..child"),
  ])
    await expect(
      planRuntimeCleanup({ ...f.options, runtimeDir }),
    ).rejects.toThrow();
  const link = join(f.base, "link");
  await symlink(f.runtimeDir, link);
  await expect(
    planRuntimeCleanup({ ...f.options, runtimeDir: link }),
  ).rejects.toThrow();
  expect(
    await planRuntimeCleanup({
      ...f.options,
      runtimeDir: join(f.base, "absent"),
    }),
  ).toEqual([]);
});

it("bounds batches and rechecks completion before dispatching exact CLI arguments", async () => {
  const f = await fixture();
  const first = await f.marker("run-aaaaaa", { done: true });
  const second = await f.marker("run-bbbbbb", { done: true });
  expect(await planRuntimeCleanup({ ...f.options, batchSize: 1 })).toEqual([
    first,
  ]);
  const calls: unknown[] = [];
  const paths = await purgeRuntime(f.options, async (file, args) => {
    // Fake runner: no files are deleted by this test.
    calls.push([file, args]);
    await writeFile(join(second, "process.json"), '{"done":false}');
  });
  expect(paths).toEqual([first]);
  expect(calls).toEqual([["rm", ["-r", "--", first]]]);
  expect(await readFile(join(first, "process.json"), "utf8")).toBe(
    '{"done":true}',
  );
});
