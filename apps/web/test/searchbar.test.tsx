import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { SearchBar } from "../src/components/SearchBar";

describe("SearchBar（/ 聚焦快捷）", () => {
  it("在非输入场景按 / 聚焦搜索框", () => {
    render(<SearchBar onSearch={() => {}} />);
    const input = screen.getByLabelText("搜索");
    expect(document.activeElement).not.toBe(input);
    fireEvent.keyDown(document.body, { key: "/" });
    expect(document.activeElement).toBe(input);
  });

  it("焦点已在输入框内时按 / 不改变焦点", () => {
    render(<SearchBar onSearch={() => {}} />);
    const input = screen.getByLabelText("搜索");
    input.focus();
    fireEvent.keyDown(input, { key: "/" });
    expect(document.activeElement).toBe(input);
  });
});
