import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const clientDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(clientDir, "..");

function copyFiltered(src, dest, accept) {
  mkdirSync(dest, { recursive: true });
  for (const name of readdirSync(src)) {
    const from = path.join(src, name);
    const to = path.join(dest, name);
    const info = lstatSync(from);
    if (info.isSymbolicLink()) {
      if (!existsSync(from)) continue;
    }
    if (info.isDirectory()) {
      copyFiltered(from, to, accept);
      continue;
    }
    if (!info.isFile() && !info.isSymbolicLink()) continue;
    if (accept(from, name)) cpSync(from, to);
  }
}

function stagePublicAssets() {
  const pub = path.join(clientDir, "public");
  mkdirSync(pub, { recursive: true });
  for (const dir of ["fonts", "previews", "emoji"]) {
    rmSync(path.join(pub, dir), { recursive: true, force: true });
  }
  copyFiltered(path.join(repoRoot, "fonts"), path.join(pub, "fonts"), (full, name) => {
    if (name === "NotoColorEmoji.ttf") return false;
    return /\.(ttf|otf|txt)$/i.test(name);
  });
  copyFiltered(path.join(repoRoot, "static", "previews"), path.join(pub, "previews"), (_full, name) =>
    name.endsWith(".png"),
  );
  copyFiltered(path.join(repoRoot, "fonts", "emoji-png"), path.join(pub, "emoji"), (_full, name) =>
    /\.(png|txt)$/i.test(name),
  );
  writeFileSync(path.join(pub, ".nojekyll"), "");
  writeFileSync(
    path.join(pub, "fonts", "README.txt"),
    [
      "Caption Studio bundles SIL Open Font License 1.1 and Apache 2.0 families only.",
      "License files sit next to each family. Noto Color Emoji is not included;",
      "keyword bursts use the OFL PNG glyphs in /emoji.",
      "Chinese, Japanese, and Korean use the device's own system fonts.",
      "",
    ].join("\n"),
  );
}

export default defineConfig({
  base: "./",
  publicDir: "public",
  build: {
    outDir: path.resolve(repoRoot, "docs"),
    emptyOutDir: true,
    target: "es2022",
    chunkSizeWarningLimit: 2500,
  },
  plugins: [
    {
      name: "caption-studio-assets",
      buildStart() {
        stagePublicAssets();
      },
    },
  ],
});
