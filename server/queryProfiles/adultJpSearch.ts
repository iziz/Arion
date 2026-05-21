import type { DomainQueryFilterEvidence, DomainSearchFilters } from "../../shared/types";
import { extractRurugrabMediaKeyCandidates } from "../metadata/rurugrab";
import { normalizeSearchValue, unique } from "../intelligenceCore/textUtils";

export type AdultJpSearchProfile = {
  active: boolean;
  filters: DomainSearchFilters;
  filterEvidence: DomainQueryFilterEvidence;
  textQuery: string;
  visualQuery: string;
  evidenceTerms: string[];
  confidenceBoost: number;
  warnings: string[];
};

const performerMarkers = ["배우", "출연", "나오는", "등장", "starring", "performer", "actor", "actress", "with"];
const noisyEntityTerms = new Set([
  "특정",
  "얼굴",
  "유사",
  "유사한",
  "비슷",
  "비슷한",
  "배우",
  "작품",
  "영상",
  "장면",
  "검색",
  "찾아줘",
  "find",
  "show",
  "search",
  "similar",
  "face",
  "performer",
  "actor",
  "actress",
  "scene",
  "video"
]);

const sceneAliases: Array<{ filter: string; terms: string[]; visual: string }> = [
  { filter: "interview", terms: ["interview", "인터뷰"], visual: "interview conversation scene" },
  { filter: "close-up", terms: ["close-up", "closeup", "클로즈업", "얼굴"], visual: "close-up face framing" },
  { filter: "car interior", terms: ["car interior", "vehicle interior", "차 안", "자동차", "차량"], visual: "inside a car or vehicle" },
  { filter: "outdoor", terms: ["outdoor", "outside", "야외", "실외"], visual: "outdoor scene" },
  { filter: "indoor", terms: ["indoor", "inside", "실내"], visual: "indoor room scene" },
  { filter: "bedroom", terms: ["bedroom", "침실", "방"], visual: "bedroom or private room" },
  { filter: "office", terms: ["office", "오피스", "사무실"], visual: "office room scene" },
  { filter: "kitchen", terms: ["kitchen", "키친", "주방"], visual: "kitchen room scene" },
  { filter: "bathroom", terms: ["bathroom", "bath", "욕실", "화장실"], visual: "bathroom scene" },
  { filter: "uniform", terms: ["uniform", "costume", "유니폼", "제복", "교복", "의상"], visual: "person wearing a uniform or costume" }
];

export function planAdultJpSearchQuery(query: string): AdultJpSearchProfile {
  const original = query.trim();
  const normalized = normalizeSearchValue(original);
  const filters: DomainSearchFilters = {};
  const filterEvidence: DomainQueryFilterEvidence = {};
  const evidenceTerms: string[] = [];
  const visualTerms: string[] = [];
  const warnings: string[] = [];
  let confidenceBoost = 0;

  const catalog = extractRurugrabMediaKeyCandidates(original)[0];
  if (catalog) {
    filters.catalogKey = catalog.mediaDisplayKey;
    filterEvidence.catalogKey = [`Matched product-code-like token: ${catalog.mediaDisplayKey}.`];
    evidenceTerms.push(catalog.mediaDisplayKey, catalog.mediaKeyNorm);
    confidenceBoost += 0.22;
  }

  const performer = extractPerformerQuery(original);
  if (performer) {
    filters.performer = performer;
    filterEvidence.performer = [`Matched performer phrase: ${performer}.`];
    evidenceTerms.push(performer);
    confidenceBoost += 0.16;
  }

  const studio = extractLabeledValue(original, ["studio", "스튜디오", "제작사"]);
  if (studio) {
    filters.studio = studio;
    filterEvidence.studio = [`Matched studio phrase: ${studio}.`];
    evidenceTerms.push(studio);
    confidenceBoost += 0.1;
  }

  const label = extractLabeledValue(original, ["label", "레이블"]);
  if (label) {
    filters.label = label;
    filterEvidence.label = [`Matched label phrase: ${label}.`];
    evidenceTerms.push(label);
    confidenceBoost += 0.08;
  }

  const series = extractLabeledValue(original, ["series", "시리즈"]);
  if (series) {
    filters.series = series;
    filterEvidence.series = [`Matched series phrase: ${series}.`];
    evidenceTerms.push(series);
    confidenceBoost += 0.1;
  }

  const genre = extractLabeledValue(original, ["genre", "장르", "태그"]);
  if (genre) {
    filters.genre = genre;
    filterEvidence.genre = [`Matched genre phrase: ${genre}.`];
    evidenceTerms.push(genre);
    confidenceBoost += 0.08;
  }

  const scene = extractSceneIntent(original);
  if (scene) {
    filters.scene = scene.filter;
    filterEvidence.scene = [`Matched scene cue: ${scene.filter}.`];
    evidenceTerms.push(scene.filter, ...scene.terms);
    visualTerms.push(scene.visual);
    confidenceBoost += 0.12;
  }

  const appearance = inferAppearanceIntent(normalized);
  if (appearance) {
    filters.appearance = appearance;
    filterEvidence.appearance = [`Matched appearance similarity cue.`];
    evidenceTerms.push("face", "person", "appearance", "similar appearance");
    visualTerms.push("similar face appearance candidate");
    warnings.push("Appearance search returns visual similarity candidates, not identity confirmation.");
    confidenceBoost += 0.14;
  }

  const active = hasAdultSearchCue(normalized, filters);
  const textQuery = unique([
    original,
    filters.catalogKey,
    filters.performer,
    filters.studio,
    filters.label,
    filters.series,
    filters.genre,
    filters.scene,
    filters.appearance ? "similar person appearance face" : "",
    ...evidenceTerms
  ].filter((value): value is string => Boolean(value?.trim()))).join(" ");
  const visualQuery = unique([
    filters.scene,
    ...visualTerms,
    filters.appearance ? "similar person face portrait candidate" : "",
    filters.performer ? "performer appearance" : ""
  ].filter((value): value is string => Boolean(value?.trim()))).join(" ");

  return {
    active,
    filters,
    filterEvidence,
    textQuery,
    visualQuery: visualQuery || textQuery,
    evidenceTerms: unique(evidenceTerms).slice(0, 16),
    confidenceBoost,
    warnings
  };
}

function hasAdultSearchCue(normalized: string, filters: DomainSearchFilters) {
  if (filters.catalogKey || filters.performer || filters.studio || filters.label || filters.series || filters.genre || filters.scene || filters.appearance) {
    return true;
  }
  return /\b(rurugrab|jav|dmm|r18|fc2|av|adult)\b/.test(normalized) || /품번|배우|출연|시리즈|제작사|레이블/.test(normalized);
}

function extractPerformerQuery(query: string) {
  const quoted = query.match(/["'“”‘’]([^"'“”‘’]{2,80})["'“”‘’]\s*(?:배우|출연|나오는|등장|performer|actor|actress|starring)/i)?.[1];
  if (quoted) return cleanEntity(quoted);

  for (const marker of performerMarkers) {
    const before = extractBeforeMarker(query, marker);
    const cleaned = cleanEntity(before);
    if (cleaned && !isNoisyEntity(cleaned)) return cleaned;
  }

  const english = query.match(/\b(?:performer|actor|actress|starring|with)\s+([A-Za-z][A-Za-z0-9 ._-]{1,60})/i)?.[1];
  const cleanedEnglish = cleanEntity(english);
  return cleanedEnglish && !isNoisyEntity(cleanedEnglish) ? cleanedEnglish : null;
}

function extractLabeledValue(query: string, labels: string[]) {
  for (const label of labels) {
    const after = query.match(new RegExp(`${escapeRegExp(label)}\\s*[:=]?\\s*([A-Za-z0-9가-힣ぁ-んァ-ン一-龯 ._-]{2,80})`, "i"))?.[1];
    const cleanedAfter = cleanEntity(after);
    if (cleanedAfter && !isNoisyEntity(cleanedAfter)) return cleanedAfter;

    const before = extractBeforeMarker(query, label);
    const cleanedBefore = cleanEntity(before);
    if (cleanedBefore && !isNoisyEntity(cleanedBefore)) return cleanedBefore;
  }
  return null;
}

function extractBeforeMarker(query: string, marker: string) {
  const index = query.toLowerCase().indexOf(marker.toLowerCase());
  if (index <= 0) return null;
  const before = query.slice(0, index);
  const chunks = before.split(/[,\n]|그리고|및|with|and/i).map((item) => item.trim()).filter(Boolean);
  return chunks.at(-1) ?? null;
}

function cleanEntity(value: string | null | undefined) {
  const cleaned = (value ?? "")
    .normalize("NFKC")
    .replace(/\b(?:find|show|search|video|scene|clip|with|starring)\b/gi, " ")
    .replace(/(?:작품|영상|장면|검색|찾아줘|보여줘|나오는|등장|출연|배우|관련|해줘)+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[._-]+|[._-]+$/g, "");
  if (cleaned.length < 2 || cleaned.length > 80) return null;
  return cleaned;
}

function isNoisyEntity(value: string) {
  const tokens = normalizeSearchValue(value).split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return true;
  const noisy = tokens.filter((token) => noisyEntityTerms.has(token)).length;
  return noisy / tokens.length > 0.5;
}

function extractSceneIntent(query: string) {
  const normalized = normalizeSearchValue(query);
  return sceneAliases.find((alias) => alias.terms.some((term) => normalized.includes(normalizeSearchValue(term)))) ?? null;
}

function inferAppearanceIntent(normalized: string): DomainSearchFilters["appearance"] | null {
  if (/비슷한\s*얼굴|유사한\s*얼굴|얼굴.*비슷|얼굴.*유사|similar\s+face|face\s+similar|lookalike|look\s+like/.test(normalized)) {
    return "similar_person";
  }
  if (/얼굴|face|appearance|외형|인물/.test(normalized)) return "person";
  return null;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
