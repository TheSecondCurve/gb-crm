import { describe, expect, it } from "vitest";

describe("smoke", () => {
  it("runs", () => {
    expect("闪光 · 客户运营").toContain("闪光");
  });
});
