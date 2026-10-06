import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Guide } from "./Guide.tsx";

describe("Guide", () => {
  it("sends quick prompts and typed questions, and shows the agent's Qloo tool trace", async () => {
    const onAsk = vi.fn();
    render(
      <Guide
        hoodName="Greenpoint"
        guide={{
          busy: false,
          turns: [
            { role: "user", text: "quieter" },
            { role: "guide", text: "Try Tea Bar.", trace: [{ tool: "find_places", summary: "6 places in Greenpoint · Quiet" }] },
          ],
        }}
        onAsk={onAsk}
      />,
    );

    expect(screen.getByText("Try Tea Bar.")).toBeTruthy();
    expect(screen.getByText(/6 places in greenpoint · quiet/i)).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "More nightlife" }));
    expect(onAsk).toHaveBeenCalledWith("More nightlife");

    await userEvent.type(screen.getByLabelText(/ask your guide/i), "somewhere for brunch{enter}");
    expect(onAsk).toHaveBeenCalledWith("somewhere for brunch");
  });
});
