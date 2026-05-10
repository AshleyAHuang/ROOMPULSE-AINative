import type { ReactNode } from "react";

interface MarkdownTable {
  headers: string[];
  rows: string[][];
}

export default function MarkdownDocument({ markdown }: { markdown: string }) {
  const lines = markdown.split("\n");
  const nodes: ReactNode[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? "";
    const tableEnd = findTableEnd(lines, index);

    if (tableEnd > index) {
      const table = parseMarkdownTable(lines.slice(index, tableEnd));
      if (table) {
        nodes.push(<MarkdownTableView key={`table-${index}`} table={table} />);
        index = tableEnd;
        continue;
      }
    }

    if (isUnorderedListLine(line)) {
      const items: string[] = [];
      const start = index;
      while (index < lines.length && isUnorderedListLine(lines[index] ?? "")) {
        items.push(stripUnorderedMarker(lines[index] ?? ""));
        index += 1;
      }
      nodes.push(
        <ul key={`list-${start}`}>
          {items.map((item, itemIndex) => (
            <li key={`${itemIndex}-${item.slice(0, 12)}`}>
              {renderInlineMarkdown(item)}
            </li>
          ))}
        </ul>
      );
      continue;
    }

    if (isOrderedListLine(line)) {
      const items: string[] = [];
      const start = index;
      while (index < lines.length && isOrderedListLine(lines[index] ?? "")) {
        items.push(stripOrderedMarker(lines[index] ?? ""));
        index += 1;
      }
      nodes.push(
        <ol key={`ordered-list-${start}`}>
          {items.map((item, itemIndex) => (
            <li key={`${itemIndex}-${item.slice(0, 12)}`}>
              {renderInlineMarkdown(item)}
            </li>
          ))}
        </ol>
      );
      continue;
    }

    nodes.push(renderMarkdownLine(line, index));
    index += 1;
  }

  return <>{nodes}</>;
}

function renderMarkdownLine(line: string, index: number): ReactNode {
  const key = `${index}-${line.slice(0, 12)}`;
  if (line.startsWith("# ")) {
    return <h1 key={key}>{renderInlineMarkdown(line.slice(2))}</h1>;
  }
  if (line.startsWith("## ")) {
    return <h2 key={key}>{renderInlineMarkdown(line.slice(3))}</h2>;
  }
  if (line.startsWith("### ")) {
    return <h3 key={key}>{renderInlineMarkdown(line.slice(4))}</h3>;
  }
  if (line.startsWith("#### ")) {
    return <h4 key={key}>{renderInlineMarkdown(line.slice(5))}</h4>;
  }
  const checkbox = line.match(/^\s*[-*]\s+\[([ xX])\]\s+(.+)$/);
  if (checkbox) {
    const checked = checkbox[1]?.toLowerCase() === "x";
    return (
      <p className="markdown-check" key={key}>
        <input checked={checked} readOnly type="checkbox" />
        <span>{renderInlineMarkdown(checkbox[2] ?? "")}</span>
      </p>
    );
  }
  if (isUnorderedListLine(line)) {
    return <li key={key}>{renderInlineMarkdown(stripUnorderedMarker(line))}</li>;
  }
  if (!line.trim()) {
    return <div className="markdown-gap" key={key} />;
  }
  return <p key={key}>{renderInlineMarkdown(line)}</p>;
}

function isUnorderedListLine(line: string): boolean {
  return /^\s*[-*]\s+(?!\[[ xX]\]\s+)/.test(line);
}

function stripUnorderedMarker(line: string): string {
  return line.replace(/^\s*[-*]\s+/, "");
}

function isOrderedListLine(line: string): boolean {
  return /^\s*\d+[.)]\s+/.test(line);
}

function stripOrderedMarker(line: string): string {
  return line.replace(/^\s*\d+[.)]\s+/, "");
}

function MarkdownTableView({ table }: { table: MarkdownTable }) {
  return (
    <div className="markdown-table-wrap">
      <table>
        <thead>
          <tr>
            {table.headers.map((header, index) => (
              <th key={`${index}-${header}`}>
                {renderInlineMarkdown(header || `Column ${index + 1}`)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {table.headers.map((_, cellIndex) => (
                <td key={cellIndex}>
                  {renderInlineMarkdown(row[cellIndex] ?? "")}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function findTableEnd(lines: string[], start: number): number {
  if (!isPipeLikeLine(lines[start] ?? "")) {
    return start;
  }

  let end = start;
  while (end < lines.length && isPipeLikeLine(lines[end] ?? "")) {
    end += 1;
  }

  return end - start >= 2 ? end : start;
}

function parseMarkdownTable(rawLines: string[]): MarkdownTable | null {
  const rows = rawLines
    .map((line) => parseTableCells(line))
    .filter((cells) => cells.length > 1);

  if (rows.length < 2) {
    return null;
  }

  const hasSeparator = isSeparatorRow(rows[1]);
  const headers = rows[0];
  const bodyRows = hasSeparator ? rows.slice(2) : rows.slice(1);
  const columnCount = Math.max(
    headers.length,
    ...bodyRows.map((row) => row.length)
  );

  return {
    headers: normalizeTableRow(headers, columnCount),
    rows: bodyRows.map((row) => normalizeTableRow(row, columnCount))
  };
}

function isPipeLikeLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("```")) {
    return false;
  }
  return parseTableCells(trimmed).length > 1;
}

function parseTableCells(line: string): string[] {
  const trimmed = line.trim();
  const withoutEdges = trimmed.replace(/^\|/, "").replace(/\|$/, "");
  return withoutEdges.split("|").map((cell) => cell.trim());
}

function isSeparatorRow(cells: string[]): boolean {
  return cells.every((cell) =>
    /^:?-{3,}:?$/.test(cell.replace(/[–—]/g, "-"))
  );
}

function normalizeTableRow(row: string[], columnCount: number): string[] {
  return Array.from({ length: columnCount }, (_, index) => row[index] ?? "");
}

function renderInlineMarkdown(text: string): ReactNode[] {
  const parts = text.split(/(\*\*[^*]+\*\*|~~[^~]+~~|`[^`]+`)/g);
  return parts.map((part, index) => {
    const key = `${index}-${part}`;
    if (part.startsWith("**") && part.endsWith("**")) {
      return <strong key={key}>{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith("~~") && part.endsWith("~~")) {
      return <s key={key}>{part.slice(2, -2)}</s>;
    }
    if (part.startsWith("`") && part.endsWith("`")) {
      return <code key={key}>{part.slice(1, -1)}</code>;
    }
    if (part.startsWith("_") && part.endsWith("_") && part.length > 1) {
      return <em key={key}>{part.slice(1, -1)}</em>;
    }
    return <span key={key}>{part}</span>;
  });
}
