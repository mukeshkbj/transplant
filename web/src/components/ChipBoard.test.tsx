import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Person } from "../state.ts";
import { ChipBoard } from "./ChipBoard.tsx";

const person: Person = {
  label: "You",
  text: "",
  resolving: false,
  chips: [
    {
      query: "Aesop",
      kind: "entity",
      status: "resolved",
      selected: { id: "b", name: "Aesop", type: "brand", kind: "entity" },
      options: [
        { id: "b", name: "Aesop", type: "brand", kind: "entity" },
        { id: "a", name: "Aesop", type: "author", kind: "entity" },
      ],
    },
    {
      query: "Lost",
      kind: "entity",
      status: "ambiguous",
      options: [
        { id: "1", name: "Lost (2004)", type: "tv_show", kind: "entity" },
        { id: "2", name: "Lost Girl", type: "tv_show", kind: "entity" },
      ],
    },
    { query: "Zzyzx", kind: "entity", status: "missing", options: [] },
  ],
};

describe("ChipBoard", () => {
  it("renders stamps, asks about ambiguous picks, and voids missing ones", async () => {
    const dispatch = vi.fn();
    render(<ChipBoard person={person} index={0} dispatch={dispatch} />);

    expect(screen.getByText("brand")).toBeTruthy();
    expect(screen.getByText(/1\/3 stamps/i)).toBeTruthy();
    expect(screen.getByText(/not in qloo/i)).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: /lost \(2004\)/i }));
    expect(dispatch).toHaveBeenCalledWith({ type: "pick", person: 0, chip: 1, optionId: "1" });

    await userEvent.click(screen.getByRole("button", { name: /remove zzyzx/i }));
    expect(dispatch).toHaveBeenCalledWith({ type: "removeChip", person: 0, chip: 2 });
  });

  it("lets a resolved stamp swap to an alternative", async () => {
    const dispatch = vi.fn();
    render(<ChipBoard person={person} index={0} dispatch={dispatch} />);

    await userEvent.click(screen.getByText(/not it\?/i));
    await userEvent.click(screen.getByRole("button", { name: /aesop · author/i }));

    expect(dispatch).toHaveBeenCalledWith({ type: "pick", person: 0, chip: 0, optionId: "a" });
  });
});
