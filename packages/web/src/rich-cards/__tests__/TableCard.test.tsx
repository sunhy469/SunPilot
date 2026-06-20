import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { TableCard } from "../components/TableCard";
import type { TableCardData } from "../types";

afterEach(cleanup);

function makeTableData(overrides: Partial<TableCardData> = {}): TableCardData {
  return {
    columns: [
      { key: "name", label: "Name", type: "text" },
      { key: "score", label: "Score", type: "number" },
    ],
    rows: [
      { name: "Alice", score: 95 },
      { name: "Bob", score: 87 },
    ],
    ...overrides,
  };
}

describe("TableCard", () => {
  test("renders a basic table with columns and rows", () => {
    render(<TableCard data={makeTableData()} />);

    // Column headers (Ant Design renders a hidden measure row duplicating header text)
    expect(screen.getAllByText("Name").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Score").length).toBeGreaterThan(0);

    // Row data
    expect(screen.getByText("Alice")).toBeInTheDocument();
    expect(screen.getByText("95")).toBeInTheDocument();
    expect(screen.getByText("Bob")).toBeInTheDocument();
    expect(screen.getByText("87")).toBeInTheDocument();
  });

  test("renders link type columns as clickable links", () => {
    const data = makeTableData({
      columns: [
        { key: "name", label: "Name", type: "text" },
        { key: "url", label: "Link", type: "link" },
      ],
      rows: [{ name: "Alice", url: "https://example.com" }],
    });
    render(<TableCard data={data} />);

    const link = screen.getByRole("link", { name: "https://example.com" });
    expect(link).toBeInTheDocument();
    expect(link).toHaveAttribute("href", "https://example.com");
  });

  test("renders badge type columns as tags", () => {
    const data = makeTableData({
      columns: [
        { key: "name", label: "Name", type: "text" },
        { key: "status", label: "Status", type: "badge" },
      ],
      rows: [{ name: "Alice", status: "success" }],
    });
    render(<TableCard data={data} />);

    // Ant Design Tag renders text content
    expect(screen.getByText("success")).toBeInTheDocument();
  });

  test("renders markdown type columns with RichTextRenderer", () => {
    const data = makeTableData({
      columns: [
        { key: "name", label: "Name", type: "text" },
        { key: "desc", label: "Description", type: "markdown" },
      ],
      rows: [{ name: "Alice", desc: "See [docs](https://example.com)" }],
    });
    render(<TableCard data={data} />);

    const link = screen.getByRole("link", { name: "docs" });
    expect(link).toBeInTheDocument();
    expect(link).toHaveAttribute("href", "https://example.com");
  });

  test("renders number type columns right-aligned", () => {
    const data = makeTableData();
    const { container } = render(<TableCard data={data} />);

    // Number cells should have textAlign: right style
    const rightAligned = container.querySelectorAll('span[style*="text-align: right"]');
    expect(rightAligned.length).toBeGreaterThan(0);
  });

  test('handles null values as "-"', () => {
    const data = makeTableData({
      rows: [{ name: null, score: null }],
    });
    render(<TableCard data={data} />);

    // Null values should render as "-"
    const dashElements = screen.getAllByText("-");
    expect(dashElements.length).toBeGreaterThanOrEqual(2);
  });

  test("supports sortable columns", () => {
    const data = makeTableData({
      columns: [
        { key: "name", label: "Name", type: "text", sortable: true },
        { key: "score", label: "Score", type: "number", sortable: true },
      ],
    });
    const { container } = render(<TableCard data={data} />);

    // Ant Design sortable columns render a column-sorter-inner element
    const sorters = container.querySelectorAll(".ant-table-column-sorters");
    expect(sorters.length).toBeGreaterThan(0);
  });

  test("supports pagination", () => {
    const rows = Array.from({ length: 15 }, (_, i) => ({
      name: `Item ${i + 1}`,
      score: i * 10,
    }));
    const data = makeTableData({
      rows,
      pagination: { pageSize: 5 },
    });
    render(<TableCard data={data} />);

    // Pagination should be present
    expect(screen.getByRole("list", { name: "" }) || screen.getByText("5")).toBeTruthy();
  });
});
