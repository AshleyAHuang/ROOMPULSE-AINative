import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import MarkdownDocument from "./MarkdownDocument";

describe("MarkdownDocument", () => {
  it("renders standard markdown tables", () => {
    render(
      <MarkdownDocument
        markdown={[
          "## Decisions",
          "| Item | Owner | Status |",
          "| --- | --- | --- |",
          "| Launch risk | Ari | Open |"
        ].join("\n")}
      />
    );

    const table = screen.getByRole("table");
    expect(within(table).getByRole("columnheader", { name: "Item" })).toBeVisible();
    expect(within(table).getByRole("cell", { name: "Launch risk" })).toBeVisible();
    expect(within(table).getByRole("cell", { name: "Ari" })).toBeVisible();
  });

  it("falls back for agent tables without separator rows", () => {
    render(
      <MarkdownDocument
        markdown={[
          "Agenda summary",
          "Item | Owner",
          "Confirm launch risk | Speaker 2"
        ].join("\n")}
      />
    );

    const table = screen.getByRole("table");
    expect(within(table).getByRole("columnheader", { name: "Item" })).toBeVisible();
    expect(
      within(table).getByRole("cell", { name: "Confirm launch risk" })
    ).toBeVisible();
  });
});
