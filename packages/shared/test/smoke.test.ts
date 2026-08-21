import { describe, expect, it } from "vitest";

import * as shared from "../src/index";

describe("smoke", () => {
  it("shared entry is importable", () => {
    expect(shared).toBeDefined();
  });
});
