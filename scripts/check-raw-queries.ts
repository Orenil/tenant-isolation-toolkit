/**
 * Real static-analysis CI gate: fails the build if any source file imports
 * `Pool` (or the `pg` module wholesale) other than `src/pool.ts` itself.
 *
 * The whole point of TenantPool is that it is the *only* code path that
 * runs a query, because it's the only thing that sets the RLS session
 * variables before doing so. A raw `new Pool()` anywhere else is a bypass
 * of tenant isolation waiting to happen -- this check makes that
 * structurally impossible to land silently.
 *
 * Implemented with the TypeScript compiler API (real AST parsing, not a
 * grep) so it isn't fooled by the string "pg" showing up in a comment or
 * an unrelated identifier, and correctly follows both named imports
 * (`import { Pool } from "pg"`) and `require("pg")` call forms.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as ts from "typescript";

export interface Violation {
  file: string;
  line: number;
  message: string;
}

const DEFAULT_ALLOWLIST = ["src/pool.ts"];
const SKIP_DIRS = new Set(["node_modules", "dist", ".pgdata", ".git", "coverage"]);

function listTsFiles(rootDir: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(path.join(dir, entry.name));
        continue;
      }
      if (entry.isFile() && /\.tsx?$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
        out.push(path.join(dir, entry.name));
      }
    }
  };
  if (fs.existsSync(rootDir)) walk(rootDir);
  return out;
}

function importsRawPg(sourceFile: ts.SourceFile): number[] {
  const lines: number[] = [];
  const flag = (node: ts.Node) => {
    const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
    lines.push(line + 1);
  };

  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      if (node.moduleSpecifier.text === "pg") flag(node);
    }
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "require" &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0]) &&
      node.arguments[0].text === "pg"
    ) {
      flag(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return lines;
}

export function checkRawQueryBypass(rootDirs: string[], allowlist: string[] = DEFAULT_ALLOWLIST): Violation[] {
  const violations: Violation[] = [];
  const normalizedAllowlist = allowlist.map((p) => path.normalize(p));

  for (const rootDir of rootDirs) {
    for (const file of listTsFiles(rootDir)) {
      const relative = path.relative(process.cwd(), file);
      if (normalizedAllowlist.some((allowed) => relative === allowed || relative.endsWith(path.sep + allowed))) {
        continue;
      }
      const content = fs.readFileSync(file, "utf8");
      const sourceFile = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true);
      for (const line of importsRawPg(sourceFile)) {
        violations.push({
          file: relative,
          line,
          message: 'imports "pg" directly -- route all queries through TenantPool (src/pool.ts) instead',
        });
      }
    }
  }
  return violations;
}

function isMain(): boolean {
  return require.main === module;
}

if (isMain()) {
  const violations = checkRawQueryBypass(["src", "examples"]);
  if (violations.length > 0) {
    console.error("Raw query bypass check FAILED:\n");
    for (const v of violations) {
      console.error(`  ${v.file}:${v.line}  ${v.message}`);
    }
    console.error(`\n${violations.length} violation(s).`);
    process.exit(1);
  }
  console.log("Raw query bypass check passed: no direct \"pg\" imports outside src/pool.ts.");
}
