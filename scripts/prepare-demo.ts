import { cp, copyFile, mkdir, writeFile, access } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
const revision = execFileSync("git", ["rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
if (!/^[a-f0-9]{40}$/.test(revision))
  throw new Error("Expected a full commit SHA");
const root = resolve("deploy/strazh-build");
try {
  await access(root);
  throw new Error("Demo staging already exists; use a fresh checkout");
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}
await mkdir(root, { recursive: true });
for (const file of ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"])
  await copyFile(file, join(root, file));
await mkdir(join(root, "apps/server"), { recursive: true });
await cp("apps/server/src", join(root, "apps/server/src"), { recursive: true });
await cp("apps/web/dist", join(root, "apps/web/dist"), { recursive: true });
await cp("packages", join(root, "packages"), { recursive: true });
await mkdir(join(root, "deploy"));
await copyFile("deploy/demo-entry.mjs", join(root, "deploy/demo-entry.mjs"));
await copyFile("deploy/Dockerfile.demo", join(root, "Dockerfile"));
await writeFile(join(root, "REVISION"), `${revision}\n`);
await writeFile(
  join(root, ".dockerignore"),
  ".git\nnode_modules\n.env*\n.codex*\n",
);
console.log(JSON.stringify({ staging: root, revision }));
