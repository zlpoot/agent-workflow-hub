import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
mkdirSync("dist/dashboard-v2", { recursive: true });
const css = spawnSync(
  process.execPath,
  [
    "node_modules/@tailwindcss/cli/dist/index.mjs",
    "-i",
    "dashboard-v2/style.css",
    "-o",
    "dist/dashboard-v2/app.css",
    "--minify",
  ],
  { encoding: "utf8", windowsHide: true },
);
process.stdout.write(css.stdout ?? "");
process.stderr.write(css.stderr ?? "");
if (css.status !== 0) throw new Error("Tailwind static CSS compilation failed");
const result = await build({
  entryPoints: ["dashboard-v2/app.tsx"],
  bundle: true,
  outfile: "dist/dashboard-v2/app.js",
  platform: "browser",
  target: "es2022",
  minify: true,
  metafile: true,
  define: { "process.env.NODE_ENV": '"production"' },
});
const forbidden = Object.keys(result.metafile.inputs).filter((path) =>
  /^(?:\.\.\/)?(?:src|tests|examples|scripts)\/|^node:|^.*\/builder\.(?:ts|js)$/.test(path),
);
if (forbidden.length)
  throw new Error(
    "Server source crossed browser boundary: " + forbidden.join(", "),
  );
copyFileSync("dashboard-v2/index.html", "dist/dashboard-v2/index.html");
const sizes = Object.fromEntries(
  ["app.js", "app.css", "index.html"].map((name) => {
    const bytes = readFileSync(`dist/dashboard-v2/${name}`);
    return [name, { bytes: bytes.length, gzip_bytes: gzipSync(bytes).length }];
  }),
);
writeFileSync(
  "dist/dashboard-v2/build-report.json",
  JSON.stringify(
    { sizes, inputs: Object.keys(result.metafile.inputs) },
    null,
    2,
  ),
);
console.log(JSON.stringify(sizes));
