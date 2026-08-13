import { describe, expect, it } from "vitest";
import * as path from "node:path";
import { checkRawQueryBypass } from "../scripts/check-raw-queries";

describe("CI lint gate: raw pg import bypass check", () => {
  it("passes a compliant fixture that only imports TenantPool", () => {
    const violations = checkRawQueryBypass([path.join("test", "fixtures", "compliant")]);
    expect(violations).toEqual([]);
  });

  it("flags a fixture that imports Pool from 'pg' directly, with file and line", () => {
    const violations = checkRawQueryBypass([path.join("test", "fixtures", "bypassing")]);
    expect(violations.length).toBe(1);
    expect(violations[0].file).toContain(path.join("test", "fixtures", "bypassing", "service.ts"));
    expect(violations[0].line).toBe(4); // the `import { Pool } from "pg";` line
  });

  it("the real source tree (src/, examples/) is itself compliant", () => {
    const violations = checkRawQueryBypass(["src", "examples"]);
    expect(violations).toEqual([]);
  });

  it("src/pool.ts is allowlisted since it IS the sanctioned pg entry point", () => {
    const violations = checkRawQueryBypass(["src"], ["src/pool.ts"]);
    expect(violations).toEqual([]);
  });

  it("without the allowlist, src/pool.ts itself would be flagged (proving the check actually inspects it)", () => {
    const violations = checkRawQueryBypass(["src"], []);
    expect(violations.some((v) => v.file.endsWith("pool.ts"))).toBe(true);
  });
});
