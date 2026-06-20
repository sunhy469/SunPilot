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
        type: "image",
        title: "Image Card",
        data: { src: "https://example.com/img.png", alt: "test" },
      },
    ];
    render(<RichCardRenderer cards={cards} />);

    expect(screen.getByText("Image Card")).toBeInTheDocument();
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
        type: "image",
        title: "Good Card",
        data: { src: "https://example.com/img.png", alt: "works" },
      },
      {
        id: "card_bad",
        type: "image",
        title: "Bad Card",
        data: null as unknown as { src: string },
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
        type: "image",
        title: "No ID Card",
        data: { src: "https://example.com/img.png", alt: "test" },
      } as RichCardView,
    ];
    const { container } = render(<RichCardRenderer cards={cards} />);

    // Card should still render with a generated key
    expect(screen.getByText("No ID Card")).toBeInTheDocument();
    const wrapper = container.querySelector('[data-card-id="image_0"]');
    expect(wrapper).toBeInTheDocument();
  });

  test("interactive cards (choice_group) correctly receive cardState and onAction", async () => {
    const onAction = vi.fn();
    const cards: RichCardView[] = [
      {
        id: "choice_1",
        type: "choice_group",
        data: {
          options: [
            { id: "opt_1", label: "选项 A" },
            { id: "opt_2", label: "选项 B" },
          ],
          mode: "single",
        },
      },
    ];
    const stateByCardId = {
      choice_1: { selectedIds: ["opt_1"] },
    };

    render(
      <RichCardRenderer
        cards={cards}
        stateByCardId={stateByCardId}
        onAction={onAction}
      />,
    );

    // ChoiceGroupCard renders Radio buttons for single mode
    const radio = screen.getAllByRole("radio");
    expect(radio.length).toBe(2);
    expect(radio[0]).toBeChecked();
    // Option text should be visible
    expect(screen.getByText("选项 A")).toBeInTheDocument();
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
