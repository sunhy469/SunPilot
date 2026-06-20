import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ChecklistCard } from "../components/InteractiveCards";
import type { ChecklistCardData } from "../types";

afterEach(cleanup);

function makeChecklistData(overrides: Partial<ChecklistCardData> = {}): ChecklistCardData {
  return {
    items: [
      { id: "item_1", label: "Read docs" },
      { id: "item_2", label: "Run tests" },
    ],
    ...overrides,
  };
}

describe("ChecklistCard", () => {
  test("renders checklist items with checkboxes", () => {
    render(<ChecklistCard data={makeChecklistData()} />);

    expect(screen.getByText("Read docs")).toBeInTheDocument();
    expect(screen.getByText("Run tests")).toBeInTheDocument();

    const checkboxes = screen.getAllByRole("checkbox");
    expect(checkboxes).toHaveLength(2);
  });

  test("toggles item checked state on click", async () => {
    const user = userEvent.setup();
    render(<ChecklistCard data={makeChecklistData()} />);

    const checkboxes = screen.getAllByRole("checkbox");
    expect(checkboxes[0]).not.toBeChecked();

    await user.click(checkboxes[0]);
    expect(checkboxes[0]).toBeChecked();
  });

  test("disables submit button when required items are not checked (requireAll mode)", () => {
    const data = makeChecklistData({
      mode: "submit",
      requireAll: true,
      items: [
        { id: "item_1", label: "Required task", required: true },
        { id: "item_2", label: "Optional task" },
      ],
    });
    render(<ChecklistCard data={data} />);

    const submitButton = screen.getByRole("button", { name: "确认提交" });
    expect(submitButton).toBeDisabled();
  });

  test("disables interaction for disabled items", () => {
    const data = makeChecklistData({
      items: [
        { id: "item_1", label: "Active item" },
        { id: "item_2", label: "Disabled item", disabled: true },
      ],
    });
    render(<ChecklistCard data={data} />);

    const checkboxes = screen.getAllByRole("checkbox");
    expect(checkboxes[0]).toBeEnabled();
    expect(checkboxes[1]).toBeDisabled();
  });

  test("calls onAction with toggle_item type in local mode", async () => {
    const user = userEvent.setup();
    const onAction = vi.fn();
    render(<ChecklistCard data={makeChecklistData({ mode: "local" })} onAction={onAction} />);

    const checkboxes = screen.getAllByRole("checkbox");
    await user.click(checkboxes[0]);

    expect(onAction).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "toggle_item",
        itemId: "item_1",
        checked: true,
      }),
    );
  });

  test("calls onAction with submit type in submit mode", async () => {
    const user = userEvent.setup();
    const onAction = vi.fn();
    const data = makeChecklistData({
      mode: "submit",
      submitLabel: "Submit",
      items: [
        { id: "item_1", label: "Task 1" },
      ],
    });
    render(<ChecklistCard data={data} onAction={onAction} />);

    const submitButton = screen.getByRole("button", { name: "Submit" });
    await user.click(submitButton);

    expect(onAction).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "submit",
      }),
    );
  });

  test("shows required indicator (*) for required items", () => {
    const data = makeChecklistData({
      items: [
        { id: "item_1", label: "Required task", required: true },
      ],
    });
    render(<ChecklistCard data={data} />);

    // The * indicator should be rendered near the label
    expect(screen.getByText("Required task")).toBeInTheDocument();
    // Ant Design Text with type="danger" renders the asterisk
    const dangerTexts = screen.getAllByText("*");
    expect(dangerTexts.length).toBeGreaterThan(0);
  });

  test("shows confirmation text when provided", () => {
    const data = makeChecklistData({
      confirmationText: "Please confirm all items before proceeding.",
    });
    render(<ChecklistCard data={data} />);

    expect(
      screen.getByText("Please confirm all items before proceeding."),
    ).toBeInTheDocument();
  });
});
