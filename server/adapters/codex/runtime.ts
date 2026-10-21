import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { resolve, relative, join, parse, sep, isAbsolute } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { homedir, tmpdir } from "node:os";

const schema = z.object({
  runtimeDir: z.string().min(1),
  profileDir: z.string().min(1),
  retentionDays: z.number().int().min(1).max(3650),
  batchSize: z.number().int().min(1).max(1000).default(100),
});
export type RuntimeCleanup = z.input<typeof schema>;

function contains(parent: string, child: string) {
  const path = relative(parent, child);
  return (
    path === "" ||
    (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path))
  );
}
async function directory(options: RuntimeCleanup) {
  const policy = schema.parse(options);
  const root = resolve(policy.runtimeDir);
  const profile = await realpath(resolve(policy.profileDir)).catch(() =>
    resolve(policy.profileDir),
  );
  if (
    root === parse(root).root ||
    root === resolve(tmpdir()) ||
    root === resolve(homedir()) ||
    contains(root, profile) ||
    contains(profile, root)
  )
    throw new Error(
      "Runtime и профиль Codex должны быть отдельными каталогами без вложения",
    );
  try {
    const info = await lstat(root);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (await realpath(root)) !== root
    )
      throw new Error("Runtime cleanup не принимает символические ссылки");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  return {
    ...policy,
    root,
    before: Date.now() - policy.retentionDays * 86400000,
  };
}
async function completed(path: string, before: number) {
  try {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) return false;
    const marker = join(path, "process.json");
    const state = await lstat(marker);
    if (
      !state.isFile() ||
      state.isSymbolicLink() ||
      state.size > 1024 ||
      state.mtimeMs >= before
    )
      return false;
    return JSON.parse(await readFile(marker, "utf8")).done === true;
  } catch {
    return false;
  }
}
export async function planRuntimeCleanup(
  options: RuntimeCleanup,
): Promise<string[]> {
  const policy = await directory(options);
  if (!policy) return [];
  const result: string[] = [];
  for (const name of (await readdir(policy.root)).sort()) {
    if (!/^run-[a-zA-Z0-9_-]{6,}$/.test(name)) continue;
    const path = join(policy.root, name);
    if (await completed(path, policy.before)) result.push(path);
    if (result.length === policy.batchSize) break;
  }
  return result;
}

// Deletion uses the standard CLI, never a shell or filesystem deletion API.
// The injected runner lets tests verify exact arguments without deleting fixtures.
export async function purgeRuntime(
  options: RuntimeCleanup,
  run: (file: string, args: string[]) => Promise<unknown> = promisify(execFile),
) {
  const paths = await planRuntimeCleanup(options);
  const deleted: string[] = [];
  const policy = await directory(options);
  if (!policy) return deleted;
  for (const path of paths) {
    if (!(await completed(path, policy.before))) continue;
    await run("rm", ["-r", "--", path]);
    deleted.push(path);
  }
  return deleted;
}
