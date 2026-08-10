/* global console, process */

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDirectory, "..");
const temporaryRoot = mkdtempSync(join(projectRoot, ".package-check-"));
const packDirectory = join(temporaryRoot, "pack");
const consumerDirectory = join(temporaryRoot, "consumer");

mkdirSync(packDirectory);
mkdirSync(consumerDirectory);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    encoding: "utf8",
    ...options,
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
    throw new Error(
      `${command} ${args.join(" ")} exited with ${String(result.status)}\n${output}`,
    );
  }

  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function runNpm(args, options = {}) {
  if (process.env.npm_execpath) {
    return run(process.execPath, [process.env.npm_execpath, ...args], options);
  }

  return run(process.platform === "win32" ? "npm.cmd" : "npm", args, {
    ...options,
    shell: process.platform === "win32",
  });
}

function parsePackReport(output) {
  const trimmed = output.trim();

  try {
    return JSON.parse(trimmed);
  } catch {
    const arrayStart = trimmed.lastIndexOf("\n[");
    if (arrayStart === -1) {
      throw new Error(`Could not parse npm pack JSON output:\n${trimmed}`);
    }

    return JSON.parse(trimmed.slice(arrayStart + 1));
  }
}

try {
  const packResult = runNpm([
    "pack",
    "--json",
    "--pack-destination",
    packDirectory,
  ]);
  const report = parsePackReport(packResult.stdout);

  if (!Array.isArray(report) || report.length !== 1) {
    throw new Error("Expected npm pack to report exactly one tarball.");
  }

  const [packedPackage] = report;
  if (
    typeof packedPackage !== "object" ||
    packedPackage === null ||
    !Array.isArray(packedPackage.files) ||
    typeof packedPackage.filename !== "string"
  ) {
    throw new Error("npm pack returned an unexpected report shape.");
  }

  const filePaths = packedPackage.files.map(({ path }) =>
    String(path).replaceAll("\\", "/"),
  );
  const requiredFiles = ["LICENSE", "README.md", "dist/cli.js", "package.json"];

  for (const requiredFile of requiredFiles) {
    if (!filePaths.includes(requiredFile)) {
      throw new Error(`Package tarball is missing ${requiredFile}.`);
    }
  }

  const unexpectedFiles = filePaths.filter(
    (path) =>
      path !== "LICENSE" &&
      path !== "README.md" &&
      path !== "package.json" &&
      !path.startsWith("dist/"),
  );

  if (unexpectedFiles.length > 0) {
    throw new Error(
      `Package tarball contains unexpected files: ${unexpectedFiles.join(", ")}`,
    );
  }

  const tarballPath = join(packDirectory, packedPackage.filename);
  writeFileSync(
    join(consumerDirectory, "package.json"),
    `${JSON.stringify({ name: "package-smoke-test", private: true }, null, 2)}\n`,
  );
  runNpm(
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--package-lock=false",
      "--prefer-offline",
      tarballPath,
    ],
    { cwd: consumerDirectory },
  );

  const installedPackageRoot = join(
    consumerDirectory,
    "node_modules",
    "@zhongxuanwu",
    "zotero-mcp",
  );
  const manifest = JSON.parse(
    readFileSync(join(installedPackageRoot, "package.json"), "utf8"),
  );

  if (manifest.bin?.["zotero-mcp"] !== "dist/cli.js") {
    throw new Error("Packed manifest does not expose the zotero-mcp binary.");
  }

  const smokeEnvironment = { ...process.env };
  delete smokeEnvironment.ZOTERO_API_KEY;

  const smokeResult = runNpm(
    ["exec", "--offline", "--", "zotero-mcp", "--help"],
    {
      cwd: consumerDirectory,
      env: smokeEnvironment,
    },
  );
  const helpOutput = `${smokeResult.stdout}\n${smokeResult.stderr}`;

  if (!/zotero-mcp/i.test(helpOutput) || !/(usage|options)/i.test(helpOutput)) {
    throw new Error("Packed binary did not print the expected --help output.");
  }

  console.log(
    `Package check passed: ${packedPackage.filename} (${String(filePaths.length)} files).`,
  );
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
