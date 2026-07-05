import type { Card } from "../cards_engine.js";

function escapeMarkdownText(value: string): string {
  return value.replace(/\r\n/g, "\n").trim();
}

function metadataLine(label: string, value: string | undefined): string | null {
  if (!value) return null;
  return `- ${label}: ${value}`;
}

export function safeMarkdownFilename(title: string, id: string): string {
  const base = title
    .normalize("NFKC")
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return (base || id || "card").replace(/\.+$/g, "") || "card";
}

export function cardToMarkdown(card: Card): string {
  const lines: string[] = [
    `# ${escapeMarkdownText(card.title)}`,
    "",
    escapeMarkdownText(card.body),
    "",
    "---",
    "",
  ];

  if (card.summary?.trim()) {
    lines.push("## Summary", "", escapeMarkdownText(card.summary), "");
  }

  const metadata = [
    metadataLine("ID", card.id),
    metadataLine("Type", card.type),
    `- Tags: ${card.tags?.length ? card.tags.join(", ") : "none"}`,
    metadataLine("URL", card.url),
    metadataLine("Created", card.createdAt),
    metadataLine("Updated", card.updatedAt),
  ].filter((line): line is string => Boolean(line));

  lines.push("## Metadata", "", ...metadata, "");

  if (card.links?.length) {
    lines.push("## Links", "", ...card.links.map((linkId) => `- ${linkId}`), "");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}
