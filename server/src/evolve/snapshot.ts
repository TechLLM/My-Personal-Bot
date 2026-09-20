import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  readdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { createHash } from "node:crypto";

const MAX_FILES = 4_000;
const MAX_BYTES = 32 * 1024 * 1024;
const MAX_DEPTH = 20;
const MAX_DEPENDENCY_FILES = 30_000;
const MAX_DEPENDENCY_BYTES = 128 * 1024 * 1024;
const MAX_DEPENDENCY_LINK_BYTES = 1024 * 1024;
const ROOT_FILES = new Set(["package.json", "bun.lock", "tsconfig.json"]);
const OMIT_PARTS = new Set(["data", "auth", "logs", ".git", "node_modules", "generated", "dist"]);
const TRUSTED_HARNESS = ["protocol.ts", "snapshot.ts", "worker.ts", "isolation.ts"] as const;
const EVOLVE_METADATA = ["surfaces.json", "golden-tasks.json"] as const;

export interface FrozenDependencies {
  files: Map<string, Buffer>;
  links: Map<string, string>;
}

export interface FrozenSource {
  sourceRoot: string;
  files: Map<string, Buffer>;
  dependencyRoot?: string;
  dependencies: FrozenDependencies;
  dependencyHash: string;
  sourceHash: string;
}

export function safeRelativePath(value: string): string {
  if (!value || value.includes("\0") || value.includes("\\") || value.startsWith("/") || /^[A-Za-z]:/.test(value))
    throw new Error("unsafe_path");
  const parts = value.split("/");
  if (parts.some((p) => !p || p === "." || p === "..")) throw new Error("unsafe_path");
  return parts.join("/");
}

function inside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith(".." + sep) && rel !== "..");
}

function assertPathWithoutSymlinks(root: string, relativePath: string): void {
  let current = root;
  for (const part of relativePath.split("/")) {
    current = join(current, part);
    if (lstatSync(current).isSymbolicLink()) throw new Error("source_symlink_forbidden");
  }
}

function captureDependencies(root: string): FrozenDependencies {
  const files = new Map<string, Buffer>();
  const links = new Map<string, string>();
  const canonical = realpathSync(root);
  let count = 0;
  let bytes = 0;
  let linkBytes = 0;
  const walk = (dir: string, rel: string, depth: number) => {
    if (depth > MAX_DEPTH) throw new Error("dependency_tree_too_large");
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (++count > MAX_DEPENDENCY_FILES) throw new Error("dependency_tree_too_large");
      const childRel = safeRelativePath(rel ? `${rel}/${entry.name}` : entry.name);
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        const target = readlinkSync(path);
        if (target.includes("\0") || target.startsWith("/") || /^[A-Za-z]:/.test(target))
          throw new Error("dependency_symlink_escape");
        const lexicalDestination = resolve(dirname(path), target);
        if (!inside(lexicalDestination, canonical)) throw new Error("dependency_symlink_escape");
        let destination: string;
        try { destination = realpathSync(path); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ELOOP") throw new Error("dependency_symlink_cycle");
          throw new Error("dependency_symlink_escape");
        }
        if (!inside(destination, canonical)) throw new Error("dependency_symlink_escape");
        const stat = lstatSync(destination);
        if (!stat.isDirectory() && !stat.isFile()) throw new Error("dependency_special_file");
        linkBytes += Buffer.byteLength(target);
        if (linkBytes > MAX_DEPENDENCY_LINK_BYTES) throw new Error("dependency_tree_too_large");
        links.set(childRel, target);
      } else if (entry.isDirectory()) {
        walk(path, childRel, depth + 1);
      } else if (entry.isFile()) {
        const stat = lstatSync(path);
        if (stat.size > MAX_DEPENDENCY_BYTES || bytes + stat.size > MAX_DEPENDENCY_BYTES)
          throw new Error("dependency_tree_too_large");
        const content = readFileSync(path);
        const after = lstatSync(path);
        if (!after.isFile() || after.isSymbolicLink() || content.length !== stat.size || after.size !== stat.size)
          throw new Error("dependency_source_changed");
        bytes += content.length;
        files.set(childRel, content);
      } else {
        throw new Error("dependency_special_file");
      }
    }
  };
  walk(canonical, "", 0);
  return { files, links };
}

function digest(files: Map<string, Buffer>): string {
  const hash = createHash("sha256");
  for (const name of [...files.keys()].sort()) {
    const bytes = files.get(name)!;
    hash.update(String(Buffer.byteLength(name)) + ":" + name + ":" + bytes.length + ":");
    hash.update(bytes);
  }
  return hash.digest("hex");
}

export function dependencyDigest(dependencies: FrozenDependencies): string {
  const hash = createHash("sha256");
  const names = [
    ...[...dependencies.files.keys()].map((name) => ({ name, type: "file" as const })),
    ...[...dependencies.links.keys()].map((name) => ({ name, type: "link" as const })),
  ].sort((a, b) => a.name.localeCompare(b.name) || a.type.localeCompare(b.type));
  for (const entry of names) {
    const value = entry.type === "file" ? dependencies.files.get(entry.name)! : Buffer.from(dependencies.links.get(entry.name)!, "utf8");
    hash.update(`${entry.type}:${Buffer.byteLength(entry.name)}:${entry.name}:${value.length}:`);
    hash.update(value);
  }
  return hash.digest("hex");
}

export function captureSource(sourceRootInput: string): FrozenSource {
  const unresolvedRoot = resolve(sourceRootInput);
  if (lstatSync(unresolvedRoot).isSymbolicLink()) throw new Error("source_root_symlink_forbidden");
  const sourceRoot = realpathSync(unresolvedRoot);
  if (!lstatSync(sourceRoot).isDirectory()) throw new Error("source_root_invalid");
  const files = new Map<string, Buffer>();
  let bytes = 0;

  const add = (rel: string, absolute: string) => {
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) throw new Error("source_symlink_forbidden");
    if (!stat.isFile()) throw new Error("source_special_file");
    if (stat.size > MAX_BYTES || bytes + stat.size > MAX_BYTES) throw new Error("source_bounds_exceeded");
    const content = readFileSync(absolute);
    bytes += content.length;
    if (files.size + 1 > MAX_FILES || bytes > MAX_BYTES) throw new Error("source_bounds_exceeded");
    files.set(rel, content);
  };

  for (const name of ROOT_FILES) {
    assertPathWithoutSymlinks(sourceRoot, name);
    add(name, join(sourceRoot, name));
  }
  assertPathWithoutSymlinks(sourceRoot, "server/src");
  const walk = (absolute: string, rel: string, depth: number) => {
    if (depth > MAX_DEPTH) throw new Error("source_depth_exceeded");
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) throw new Error("source_symlink_forbidden");
    if (!stat.isDirectory()) return add(rel, absolute);
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      if (OMIT_PARTS.has(entry.name) || entry.name.startsWith(".env")) continue;
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (childRel === "server/src/evolve" || childRel === "evolve/candidates" || childRel === "updates-outbox") continue;
      walk(join(absolute, entry.name), childRel, depth + 1);
    }
  };
  walk(join(sourceRoot, "server", "src"), "server/src", 0);
  for (const optional of ["shared"]) {
    try { walk(join(sourceRoot, optional), optional, 0); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  for (const name of EVOLVE_METADATA) {
    try {
      assertPathWithoutSymlinks(sourceRoot, `evolve/${name}`);
      add(`evolve/${name}`, join(sourceRoot, "evolve", name));
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }

  for (const name of TRUSTED_HARNESS) {
    const absolute = join(import.meta.dir, name);
    const stat = lstatSync(absolute);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES || bytes + stat.size > MAX_BYTES)
      throw new Error("trusted_harness_invalid");
    const rel = `server/src/evolve/${name}`;
    const previous = files.get(rel);
    const content = readFileSync(absolute);
    const replacedBytes = previous?.length ?? 0;
    if (content.length > MAX_BYTES || bytes - replacedBytes + content.length > MAX_BYTES || (!previous && files.size + 1 > MAX_FILES))
      throw new Error("trusted_harness_invalid");
    if (previous) bytes -= previous.length;
    bytes += content.length;
    files.set(rel, content);
  }

  let dependencyRoot: string | undefined;
  let dependencies: FrozenDependencies = { files: new Map(), links: new Map() };
  const modules = join(sourceRoot, "node_modules");
  let modulesPresent = true;
  try {
    lstatSync(modules);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") modulesPresent = false;
    else throw error;
  }
  if (modulesPresent) {
    const knownRoot = join(import.meta.dir, "..", "..", "..", "node_modules");
    let canonicalKnown: string;
    let canonicalSupplied: string;
    try {
      canonicalKnown = realpathSync(knownRoot);
      canonicalSupplied = realpathSync(modules);
    } catch {
      throw new Error("dependency_root_untrusted");
    }
    if (canonicalSupplied !== canonicalKnown || !lstatSync(canonicalKnown).isDirectory())
      throw new Error("dependency_root_untrusted");
    dependencyRoot = canonicalKnown;
    dependencies = captureDependencies(canonicalKnown);
    if (realpathSync(modules) !== canonicalKnown) throw new Error("dependency_root_untrusted");
  }
  return {
    sourceRoot,
    files,
    dependencyRoot,
    dependencies,
    dependencyHash: dependencyDigest(dependencies),
    sourceHash: digest(files),
  };
}

export function materializeSnapshot(source: FrozenSource, destination: string): void {
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  for (const [name, bytes] of source.files) {
    const path = join(destination, name);
    mkdirSync(dirname(path), { recursive: true, mode: 0o755 });
    copyFileFromBuffer(path, bytes);
  }
  if (source.dependencies.files.size || source.dependencies.links.size) {
    const modules = join(destination, "node_modules");
    mkdirSync(modules, { recursive: true, mode: 0o755 });
    for (const [name, bytes] of source.dependencies.files) {
      const path = join(modules, safeRelativePath(name));
      mkdirSync(dirname(path), { recursive: true, mode: 0o755 });
      copyFileFromBuffer(path, bytes);
    }
    for (const [name, target] of [...source.dependencies.links].sort(([a], [b]) => a.localeCompare(b))) {
      const path = join(modules, safeRelativePath(name));
      mkdirSync(dirname(path), { recursive: true, mode: 0o755 });
      symlinkSync(target, path);
    }
  }
  mkdirSync(join(destination, "server", "data"), { recursive: true, mode: 0o700 });
  mkdirSync(join(destination, "tmp"), { recursive: true, mode: 0o700 });
}

function copyFileFromBuffer(path: string, bytes: Buffer) {
  writeFileSync(path, bytes, { mode: 0o600 });
  chmodSync(path, 0o444);
}

export function applySourceCandidate(root: string, relativePath: string, content: string): void {
  const rel = safeRelativePath(relativePath);
  const path = join(root, rel);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("candidate_target_invalid");
  chmodSync(path, 0o600);
  writeFileSync(path, content, { mode: 0o600 });
  chmodSync(path, 0o444);
}

export function hashSnapshot(root: string, manifest: Iterable<string>): string {
  const files = new Map<string, Buffer>();
  for (const name of manifest) {
    const path = resolve(root, safeRelativePath(name));
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("snapshot_file_changed");
    files.set(name, readFileSync(path));
  }
  return digest(files);
}

export function hashFrozenDeps(root: string, expected: FrozenDependencies): string {
  const modules = join(root, "node_modules");
  const actual: FrozenDependencies = { files: new Map(), links: new Map() };
  let present = true;
  try { lstatSync(modules); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") present = false;
    else throw new Error("dependency_mutated");
  }
  if (!present) {
    if (expected.files.size || expected.links.size) throw new Error("dependency_mutated");
    return dependencyDigest(actual);
  }
  if (!lstatSync(modules).isDirectory() || lstatSync(modules).isSymbolicLink()) throw new Error("dependency_mutated");
  const expectedDirs = new Set<string>([""]);
  for (const name of [...expected.files.keys(), ...expected.links.keys()]) {
    let parent = dirname(name).replace(/\\/g, "/");
    while (parent !== "." && !expectedDirs.has(parent)) {
      expectedDirs.add(parent);
      parent = dirname(parent).replace(/\\/g, "/");
    }
  }
  const walk = (dir: string, rel: string, depth: number) => {
    if (depth > MAX_DEPTH) throw new Error("dependency_mutated");
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const childRel = safeRelativePath(rel ? `${rel}/${entry.name}` : entry.name);
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) actual.links.set(childRel, readlinkSync(path));
      else if (entry.isDirectory()) {
        if (!expectedDirs.has(childRel)) throw new Error("dependency_mutated");
        walk(path, childRel, depth + 1);
      } else if (entry.isFile()) actual.files.set(childRel, readFileSync(path));
      else throw new Error("dependency_mutated");
    }
  };
  walk(modules, "", 0);
  if (actual.files.size !== expected.files.size || actual.links.size !== expected.links.size)
    throw new Error("dependency_mutated");
  for (const [name, bytes] of expected.files) {
    const value = actual.files.get(name);
    if (!value || !value.equals(bytes)) throw new Error("dependency_mutated");
  }
  for (const [name, target] of expected.links) {
    if (actual.links.get(name) !== target) throw new Error("dependency_mutated");
  }
  return dependencyDigest(actual);
}

export function hashBytes(parts: Array<string | Buffer>): string {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part);
  return hash.digest("hex");
}
