import { createHash, randomUUID } from "node:crypto";

export function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function opaqueId(prefix) {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

export function stableOpaqueId(prefix, value) {
  return `${prefix}_${createHash("sha256").update(value).digest("hex").slice(0, 24)}`;
}

export function slugify(value, fallback = "task") {
  const slug = value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 42);
  return slug || fallback;
}
