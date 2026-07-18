import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { sha256 } from "./identity.mjs";

export function statePaths(repoRoot) {
  const root = join(repoRoot, ".ai", "state");
  return {
    root,
    current: join(root, "current.json"),
    objects: join(root, "objects", "sha256"),
    tasks: join(root, "tasks")
  };
}

export async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

export async function writeJsonAtomic(path, value) {
  await writeTextAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

export async function writeTextAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, value, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, path);
}

export async function readCurrentTask(repoRoot) {
  try {
    return await readJson(statePaths(repoRoot).current);
  } catch (error) {
    if (error.code === "ENOENT") throw new Error("No active Aiviron task exists in this repository");
    throw error;
  }
}

export async function putObject(repoRoot, value, mediaType) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  const digest = sha256(bytes);
  const hex = digest.slice("sha256:".length);
  const path = join(statePaths(repoRoot).objects, hex.slice(0, 2), hex.slice(2));
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  return {
    digest,
    mediaType,
    size: bytes.byteLength,
    uri: `aiviron-object://sha256/${hex}`
  };
}
