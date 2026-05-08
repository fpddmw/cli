const fs = require("node:fs");
const path = require("node:path");

const repoRoot = process.cwd();
const scanRoots = ["src", "test", "bin", "scripts"];
const skipFiles = new Set(["assert-no-coverage-ignore.cjs"]);
const sourceExtensions = new Set([".js", ".ts", ".cjs", ".mjs"]);
const coverageIgnorePattern = /\b(?:c8|istanbul|v8)\s+ignore\b/iu;

function collectSourceFiles(relativeDir) {
  const absoluteDir = path.join(repoRoot, relativeDir);
  if (!fs.existsSync(absoluteDir)) return [];

  const files = [];
  for (const entry of fs.readdirSync(absoluteDir, { withFileTypes: true })) {
    const relativePath = path.join(relativeDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectSourceFiles(relativePath));
      continue;
    }
    if (skipFiles.has(entry.name) || !sourceExtensions.has(path.extname(entry.name))) {
      continue;
    }
    files.push(path.join(repoRoot, relativePath));
  }
  return files;
}

const violations = [];
for (const scanRoot of scanRoots) {
  for (const filePath of collectSourceFiles(scanRoot)) {
    const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/u);
    lines.forEach((line, index) => {
      if (coverageIgnorePattern.test(line)) {
        violations.push({
          filePath: path.relative(repoRoot, filePath),
          line: index + 1,
          text: line.trim(),
        });
      }
    });
  }
}

if (violations.length > 0) {
  process.stderr.write(
    [
      "Coverage ignore pragmas are forbidden in this repo.",
      "Cover edge cases with tests instead of c8/istanbul/v8 ignore directives.",
      "",
      ...violations.map(
        (violation) => `- ${violation.filePath}:${violation.line} ${violation.text}`,
      ),
      "",
    ].join("\n"),
  );
  process.exit(1);
}

process.stdout.write("Coverage ignore guard passed: no forbidden pragmas found.\n");
