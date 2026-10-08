/** @jest-environment jsdom */

import { fireEvent, render, screen } from "@testing-library/react";
import QuickPrompts, { QUICK_PROMPTS } from "../../src/renderer/pages/chat/Editor/QuickPrompts";

jest.mock("@fluentui/react-components", () => {
  const React = require("react");
  return {
    Button: ({ children, ...props }: { children: React.ReactNode }) => React.createElement("button", props, children),
  };
});

describe("QuickPrompts", () => {
  it("renders six compact examples with their full natural-language prompts", () => {
    render(<QuickPrompts onSelect={() => undefined} />);

    expect(screen.getByRole("group", { name: "Quick Prompts" })).toBeTruthy();
    expect(screen.getAllByRole("button")).toHaveLength(QUICK_PROMPTS.length);
    QUICK_PROMPTS.forEach(({ label }) => {
      expect(screen.getByRole("button", { name: label })).toBeTruthy();
    });
  });

  it("only fills through the selection callback and does not submit", () => {
    const onSelect = jest.fn();
    render(<QuickPrompts onSelect={onSelect} />);

    fireEvent.click(screen.getByRole("button", { name: "\u8d85\u7ea7\u90fd\u5e02" }));

    expect(onSelect).toHaveBeenCalledWith("\u5e2e\u6211\u5efa\u7acb\u4e00\u4e2a\u8d85\u7ea7\u90fd\u5e02");
  });
});
