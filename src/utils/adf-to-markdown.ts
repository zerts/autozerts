import type { AdfDocument, AdfNode, AdfMark } from "../types/jira";

/**
 * Convert Atlassian Document Format (ADF) to Markdown.
 * Handles the most common node types used in JIRA descriptions.
 */
export function adfToMarkdown(doc: AdfDocument | null): string {
  if (!doc || !doc.content) return "";
  return doc.content.map((node) => convertNode(node)).join("\n\n");
}

function convertNode(node: AdfNode, listDepth = 0): string {
  switch (node.type) {
    case "paragraph":
      return convertChildren(node);

    case "heading": {
      const level = (node.attrs?.level as number) ?? 1;
      const prefix = "#".repeat(level);
      return `${prefix} ${convertChildren(node)}`;
    }

    case "text":
      return applyMarks(node.text ?? "", node.marks);

    case "hardBreak":
      return "\n";

    case "bulletList":
      return (node.content ?? [])
        .map((item) => convertListItem(item, listDepth, "-"))
        .join("\n");

    case "orderedList":
      return (node.content ?? [])
        .map((item, i) => convertListItem(item, listDepth, `${i + 1}.`))
        .join("\n");

    case "listItem": {
      const children = node.content ?? [];
      return children.map((child) => convertNode(child, listDepth)).join("\n");
    }

    case "codeBlock": {
      const lang = (node.attrs?.language as string) ?? "";
      const code = convertChildren(node);
      return `\`\`\`${lang}\n${code}\n\`\`\``;
    }

    case "blockquote": {
      const content = (node.content ?? [])
        .map((child) => convertNode(child))
        .join("\n");
      return content
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n");
    }

    case "rule":
      return "---";

    case "table":
      return convertTable(node);

    case "mediaGroup":
    case "mediaSingle":
      return convertMedia(node);

    case "inlineCard": {
      const url = node.attrs?.url as string | undefined;
      return url ? `[${url}](${url})` : "";
    }

    case "emoji":
      return (node.attrs?.shortName as string) ?? "";

    case "mention": {
      const mentionText = (node.attrs?.text as string) ?? "@unknown";
      return `**${mentionText}**`;
    }

    case "panel": {
      const panelContent = (node.content ?? [])
        .map((child) => convertNode(child))
        .join("\n");
      return `> ${panelContent}`;
    }

    default:
      if (node.content) return convertChildren(node);
      return node.text ?? "";
  }
}

function convertChildren(node: AdfNode): string {
  if (!node.content) return node.text ?? "";
  return node.content.map((child) => convertNode(child)).join("");
}

function convertListItem(node: AdfNode, depth: number, bullet: string): string {
  const indent = "  ".repeat(depth);
  const children = node.content ?? [];
  const lines: string[] = [];

  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    if (child.type === "bulletList" || child.type === "orderedList") {
      lines.push(convertNode(child, depth + 1));
    } else {
      const text = convertNode(child, depth);
      if (i === 0) {
        lines.push(`${indent}${bullet} ${text}`);
      } else {
        lines.push(`${indent}  ${text}`);
      }
    }
  }

  return lines.join("\n");
}

function applyMarks(text: string, marks?: AdfMark[]): string {
  if (!marks || marks.length === 0) return text;

  let result = text;
  for (const mark of marks) {
    switch (mark.type) {
      case "strong":
        result = `**${result}**`;
        break;
      case "em":
        result = `*${result}*`;
        break;
      case "code":
        result = `\`${result}\``;
        break;
      case "strike":
        result = `~~${result}~~`;
        break;
      case "link": {
        const href = mark.attrs?.href as string | undefined;
        if (href) result = `[${result}](${href})`;
        break;
      }
      case "underline":
        result = `<u>${result}</u>`;
        break;
    }
  }
  return result;
}

function convertTable(node: AdfNode): string {
  const rows = node.content ?? [];
  if (rows.length === 0) return "";

  const tableData: string[][] = [];
  let isHeader = false;

  for (const row of rows) {
    const cells = (row.content ?? []).map((cell) => {
      if (cell.type === "tableHeader") isHeader = true;
      return (cell.content ?? []).map((child) => convertNode(child)).join(" ");
    });
    tableData.push(cells);
  }

  if (tableData.length === 0) return "";

  const colCount = Math.max(...tableData.map((r) => r.length));
  const lines: string[] = [];

  for (let i = 0; i < tableData.length; i++) {
    const row = tableData[i];
    while (row.length < colCount) row.push("");
    lines.push(`| ${row.join(" | ")} |`);
    if (i === 0 && isHeader) {
      lines.push(`| ${Array(colCount).fill("---").join(" | ")} |`);
    }
  }

  // If no header row was detected, add separator after first row anyway
  if (!isHeader && tableData.length > 0) {
    lines.splice(1, 0, `| ${Array(colCount).fill("---").join(" | ")} |`);
  }

  return lines.join("\n");
}

function convertMedia(node: AdfNode): string {
  const mediaNodes = node.content ?? [];
  return mediaNodes
    .map((media) => {
      const alt = (media.attrs?.alt as string) ?? "image";
      return `![${alt}]`;
    })
    .join("\n");
}
