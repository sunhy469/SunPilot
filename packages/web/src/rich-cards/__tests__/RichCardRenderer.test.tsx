import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { RichCardRenderer } from "../RichCardRenderer";
import type { RichCardView, RichCardAction } from "../types";

afterEach(cleanup);

describe("RichCardRenderer", () => {
  test("renders known card types correctly", () => {
    const cards: RichCardView[] = [
      {
        id: "card_1",
        type: "info",
        title: "Info Card",
        data: { text: "This is an info card" },
      },
    ];
    render(<RichCardRenderer cards={cards} />);

    expect(screen.getByText("Info Card")).toBeInTheDocument();
    expect(screen.getByText("This is an info card")).toBeInTheDocument();
  });

  test("renders fallback for unknown card types", () => {
    const cards: RichCardView[] = [
      {
        id: "card_unknown",
        type: "nonexistent_type" as RichCardView["type"],
        title: "Unknown",
        data: {},
      },
    ];
    render(<RichCardRenderer cards={cards} />);

    expect(screen.getByText(/未知卡片类型/)).toBeInTheDocument();
  });

  test("isolates errors per card (one failing card doesn't crash others)", () => {
    // Create a card that will cause a render error by providing invalid data
    // The error boundary should catch it and show "卡片渲染失败"
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const cards: RichCardView[] = [
      {
        id: "card_good",
        type: "info",
        title: "Good Card",
        data: { text: "This works fine" },
      },
      {
        id: "card_bad",
        type: "summary",
        title: "Bad Card",
        data: null as unknown as { text: string },
      },
    ];

    // The error boundary should catch the error from the bad card
    // and still render the good card
    const { container } = render(<RichCardRenderer cards={cards} />);

    // Good card should still render
    expect(screen.getByText("Good Card")).toBeInTheDocument();

    // Error boundary should show fallback
    expect(screen.getByText("卡片渲染失败")).toBeInTheDocument();

    consoleSpy.mockRestore();
  });

  test("generates fallback key for cards without id", () => {
    const cards: RichCardView[] = [
      {
        id: "",
        type: "info",
        title: "No ID Card",
        data: { text: "Missing ID" },
      } as RichCardView,
    ];
    const { container } = render(<RichCardRenderer cards={cards} />);

    // Card should still render with a generated key
    expect(screen.getByText("No ID Card")).toBeInTheDocument();
    const wrapper = container.querySelector('[data-card-id="info_0"]');
    expect(wrapper).toBeInTheDocument();
  });

  test("passes cardState and onAction to interactive cards", async () => {
    const onAction = vi.fn();
    const cards: RichCardView[] = [
      {
        id: "check_1",
        type: "checklist",
        data: {
          items: [
            { id: "item_1", label: "Task A" },
          ],
          mode: "local",
        },
      },
    ];
    const stateByCardId = {
      check_1: { checkedItemIds: ["item_1"] },
    };

    render(
      <RichCardRenderer
        cards={cards}
        stateByCardId={stateByCardId}
        onAction={onAction}
      />,
    );

    // The checkbox should be checked based on cardState
    const checkbox = screen.getByRole("checkbox");
    expect(checkbox).toBeChecked();
  });

  test("returns null for empty cards array", () => {
    const { container } = render(<RichCardRenderer cards={[]} />);
    expect(container.innerHTML).toBe("");
  });

  test("returns null for undefined cards", () => {
    const { container } = render(<RichCardRenderer cards={undefined} />);
    expect(container.innerHTML).toBe("");
  });
});
