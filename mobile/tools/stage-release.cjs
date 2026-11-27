const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");

const mobile = path.resolve(__dirname, "..");
const local = path.join(mobile, ".lecodes");
const release = path.join(local, "release");
const files = new Set([
  ".gitignore", ".lecodesignore", "app.json", "main.ts", "navigation.ts", "start-app.ts",
  "api/ai-input.ts", "api/client.ts", "api/config.ts", "api/http.ts",
  "proposals/diff.ts", "proposals/export.ts", "proposals/model.ts",
  "screens/ai-input.ts", "screens/creation-methods.ts", "screens/order-detail.ts", "screens/order-form.ts",
  "screens/orders.ts", "screens/proposal-editor.ts", "screens/proposal-export.ts", "screens/proposal-history.ts",
  "screens/proposal.ts", "screens/service-detail.ts", "screens/service-form.ts", "screens/services.ts",
  "ui/async.ts", "ui/components.ts", "ui/delete-dialog.ts", "ui/fields.ts", "ui/form-focus.ts", "ui/proposal-document.ts",
  "ui/service-picker.ts", "ui/theme.ts",
  "assets/fonts/golos-text-400.ttf", "assets/fonts/golos-text-600.ttf", "assets/fonts/golos-text-700.ttf",
  "assets/fonts/golos-text-800.ttf", "fonts.lock.json", "FONT-NOTICES.md",
]);

function scanRelease(directory, allowedFiles, prefix = "") {
  for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
    const relative = prefix + item.name;
    if (relative === ".lecodes" && item.isDirectory()) continue;
    const target = path.join(directory, item.name);
    if (item.isDirectory() && [...allowedFiles].some((file) => file.startsWith(`${relative}/`))) {
      scanRelease(target, allowedFiles, `${relative}/`);
    } else if (!item.isFile() || !allowedFiles.has(relative)) {
      throw new Error(`Unexpected file or directory in release staging: ${relative}`);
    }
  }
}

function allowedReleaseFiles(metadata) {
  const manifest = path.join(metadata, "manifest.json");
  const manifestStat = fs.lstatSync(manifest, { throwIfNoEntry: false });
  if (!manifestStat) return files;
  if (!manifestStat.isFile()) throw new Error("Expected a regular .lecodes/manifest.json");

  const serverEntry = JSON.parse(fs.readFileSync(manifest, "utf8")).files?.["/app.server.ts"];
  if (!serverEntry) return files;

  const serverFile = path.join(release, "app.server.ts");
  const serverStat = fs.lstatSync(serverFile, { throwIfNoEntry: false });
  if (!serverStat?.isFile()) {
    throw new Error("The linked project tracks app.server.ts. Restore its exact copy in .lecodes/release before staging.");
  }
  const hash = createHash("sha256").update(fs.readFileSync(serverFile)).digest("hex");
  if (hash !== serverEntry.sha) {
    throw new Error("The staged app.server.ts differs from the linked baseline. Use a copy that matches the manifest.");
  }
  return new Set([...files, "app.server.ts"]);
}

function ensurePlainDirectory(directory) {
  if (!fs.existsSync(directory)) fs.mkdirSync(directory);
  if (!fs.lstatSync(directory).isDirectory()) throw new Error(`Expected a regular directory: ${directory}`);
}

try {
  ensurePlainDirectory(local);
  ensurePlainDirectory(release);
  const metadata = path.join(release, ".lecodes");
  ensurePlainDirectory(metadata);
  scanRelease(release, allowedReleaseFiles(metadata));

  for (const relative of files) {
    const source = path.join(mobile, relative);
    if (!fs.lstatSync(source).isFile() || fs.realpathSync(source) !== source) {
      throw new Error(`Expected a regular workspace file: ${relative}`);
    }
  }

  for (const relative of files) {
    const target = path.join(release, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(mobile, relative), target);
  }

  fs.appendFileSync(path.join(release, ".lecodesignore"),
    "\n# Development-only files\n/dev-mock.ts\n/demo-data.ts\n/api/mock.ts\n/api/mock-ai.ts\n/tests/\n");
  console.log(`Release source staged in ${release}`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
