import {
  assignKJGroup,
  createCard,
  createKJGroup,
  linkCards,
  loadCards,
  loadKJGroups,
} from "../cards_engine.js";
import { saveArticlesToDb } from "../repositories/articles_repository.js";

const demoCards = [
  {
    title: "Demo: BM25 search and highlight",
    body: "BM25 search ranks local cards and highlights matched keywords in title, body, summary, and tags.",
    summary: "Use this card to verify BM25 search result highlighting and match explanations.",
    tags: ["demo", "bm25", "search", "highlight"],
    type: "memo" as const,
  },
  {
    title: "Demo: SQLite migration from JSON",
    body: "The app moved from JSON file storage to SQLite while keeping card CRUD behavior stable.",
    summary: "SQLite migration demo card for backend portfolio discussion.",
    tags: ["demo", "sqlite", "migration"],
    type: "memo" as const,
  },
  {
    title: "Demo: Zod validation for APIs",
    body: "Zod validation rejects empty titles, oversized bodies, invalid IDs, malformed URLs, and unexpected input before application logic runs.",
    summary: "Input validation improves API quality and reduces invalid states.",
    tags: ["demo", "zod", "validation", "api"],
    type: "memo" as const,
  },
  {
    title: "Demo: API testing with Vitest and Supertest",
    body: "API tests cover normal card creation, invalid requests, bulk operations, links, imports, health checks, and search metadata.",
    summary: "Automated tests make backend behavior easier to change safely.",
    tags: ["demo", "testing", "vitest", "supertest"],
    type: "memo" as const,
  },
  {
    title: "Demo: Docker build and CI checks",
    body: "GitHub Actions runs npm ci, typecheck, tests, npm audit, and Docker build checks for the Express and SQLite app.",
    summary: "CI and Docker checks help demonstrate reproducible backend operation.",
    tags: ["demo", "docker", "ci"],
    type: "memo" as const,
  },
  {
    title: "Demo: KJ method board grouping",
    body: "KJ method grouping helps organize cards into clusters for knowledge management and portfolio demonstrations.",
    summary: "This card can be assigned to a demo KJ group.",
    tags: ["demo", "kj", "grouping"],
    type: "memo" as const,
  },
  {
    title: "Demo: Backup and restore workflow",
    body: "CLI-based backup and restore scripts copy and restore the SQLite database used by this local-first app.",
    summary: "Operational tooling demo for local backup, restore, and export workflows.",
    tags: ["demo", "backup", "restore", "sqlite"],
    type: "memo" as const,
  },
  {
    title: "Demo: XSS safety plain text rendering",
    body: 'This card contains <script>alert("xss")</script> as plain text to test safe rendering.',
    summary: "HTML-like text should be displayed as text, not executed as markup.",
    tags: ["demo", "xss", "security", "highlight"],
    type: "memo" as const,
  },
];

const existingCards = loadCards();
const existingByTitle = new Map(existingCards.map((card) => [card.title, card]));
const createdOrExisting = [];
let inserted = 0;

for (const card of demoCards) {
  const existing = existingByTitle.get(card.title);
  if (existing) {
    createdOrExisting.push(existing);
    continue;
  }

  const created = await createCard({
    ...card,
    links: [],
  });
  createdOrExisting.push(created);
  inserted += 1;
}

const groups = loadKJGroups();
const demoGroup = groups.find((group) => group.name === "Demo: Backend Portfolio") ??
  createKJGroup("Demo: Backend Portfolio", "Demo cards for search, security, testing, and operations.", "#4D96FF");

for (const card of createdOrExisting.slice(0, 6)) {
  await assignKJGroup(card.id, demoGroup.id);
}

for (const [sourceTitle, targetTitle] of [
  ["Demo: BM25 search and highlight", "Demo: XSS safety plain text rendering"],
  ["Demo: SQLite migration from JSON", "Demo: Backup and restore workflow"],
  ["Demo: Zod validation for APIs", "Demo: API testing with Vitest and Supertest"],
] as const) {
  const source = createdOrExisting.find((card) => card.title === sourceTitle);
  const target = createdOrExisting.find((card) => card.title === targetTitle);
  if (source && target) linkCards(source.id, target.id);
}

saveArticlesToDb([{
  id: "demo_candidate_bm25",
  title: "Demo candidate: SQLite BM25 ranking",
  body: "This collected fixture demonstrates candidate score, match reason, review, save, and normal card search.",
  summary: "Local candidate fixture for the 15-minute demo.",
  url: "https://example.test/demo-candidate-bm25",
  source: "fixture:demo",
  sourceAuthority: 0.95,
  publishedAt: new Date(),
  tokens: ["sqlite", "bm25", "ranking", "candidate"],
  docLength: 4,
}]);

console.log(JSON.stringify({
  ok: true,
  inserted,
  skipped: demoCards.length - inserted,
  kjGroup: demoGroup.name,
  linkedPairs: 3,
}, null, 2));
