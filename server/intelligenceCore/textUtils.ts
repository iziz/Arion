import { createHash } from "node:crypto";

const stopWords = new Set([
  "the",
  "and",
  "for",
  "with",
  "from",
  "this",
  "that",
  "there",
  "any",
  "video",
  "movie",
  "clip",
  "clips",
  "sample",
  "about",
  "related",
  "relating",
  "available",
  "find",
  "show",
  "search",
  "moment",
  "moments",
  "scene",
  "scenes",
  "into",
  "your",
  "you",
  "are",
  "was",
  "were",
  "have",
  "has",
  "where",
  "when",
  "what",
  "how"
]);

export function checksum(input: string) {
  return createHash("sha256").update(input).digest("hex");
}

export function extractKeywords(input: string) {
  return unique(
    input
      .toLowerCase()
      .replace(/[^a-z0-9가-힣\s-]/g, " ")
      .split(/\s+/)
      .map((term) => term.trim().replace(/^-+|-+$/g, ""))
      .filter((term) => !stopWords.has(term) && (/[가-힣]/.test(term) ? term.length >= 2 : term.length > 2))
  ).slice(0, 24);
}

export function vectorize(input: string) {
  const vector = new Array(16).fill(0);
  for (const term of extractKeywords(input)) {
    const hash = createHash("sha1").update(term).digest();
    for (let index = 0; index < vector.length; index += 1) {
      vector[index] += (hash[index] - 128) / 128;
    }
  }
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  return vector.map((value) => Number((value / magnitude).toFixed(4)));
}

export function cosineSimilarity(a: number[], b: number[]) {
  if (a.length === 0 || b.length === 0) return 0;
  const length = Math.min(a.length, b.length);
  let dot = 0;
  for (let index = 0; index < length; index += 1) {
    dot += a[index] * b[index];
  }
  return Math.max(0, Number(dot.toFixed(3)));
}

export function normalizeSearchValue(value: string) {
  return value.toLowerCase().normalize("NFKD").replace(/\s+/g, " ").trim();
}

export function unique<T>(items: T[]) {
  return Array.from(new Set(items));
}

export function toTitleCase(input: string) {
  return input.replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function formatTime(seconds: number) {
  const safe = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(safe / 60);
  const rest = safe % 60;
  return `${minutes}:${rest.toString().padStart(2, "0")}`;
}
