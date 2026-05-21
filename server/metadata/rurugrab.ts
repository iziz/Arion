import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import { externalMetadataToSearchText, mergeExternalMetadataTags } from "../../shared/externalMetadata";
import type { AssetRecord, ExternalMediaMetadata } from "../../shared/types";

const execFileAsync = promisify(execFile);

export const defaultRurugrabMetadataDbPath = "/Users/ishtar/.rurugrab/localdb.metadata.sqlite3";

type MediaKeyCandidate = {
  mediaKeyNorm: string;
  mediaDisplayKey: string;
  evidence: string;
  confidence: number;
};

type RurugrabProviderRow = {
  media_id: number;
  media_key_norm: string;
  media_display_key: string;
  search_text: string | null;
  provider_count: number;
  release_date_key: number | null;
  provider: string | null;
  title: string | null;
  payload_json: string | null;
};

type JsonRecord = Record<string, unknown>;

const commonFalsePrefixes = new Set(["VIDEO", "MOVIE", "SCENE", "CLIP", "FINAL", "SAMPLE", "PART", "FULLHD", "FHD", "UHD"]);

export function extractRurugrabMediaKeyCandidates(input: string) {
  const normalized = input.normalize("NFKC").toUpperCase();
  const candidates = new Map<string, MediaKeyCandidate>();
  for (const match of normalized.matchAll(/(?:^|[^A-Z0-9])([A-Z]{2,10})[-_\s]?(\d{2,6})(?=$|[^A-Z0-9])/g)) {
    const prefix = match[1];
    const digits = match[2];
    if (!prefix || !digits || commonFalsePrefixes.has(prefix)) continue;
    for (const digitValue of digitVariants(digits)) {
      addMediaKeyCandidate(candidates, prefix, digitValue, match[0].trim(), match[0].includes("-") ? 0.96 : 0.88);
    }
  }
  for (const match of normalized.matchAll(/(?:^|[^A-Z0-9])(FC2)[-_\s]?(?:PPV[-_\s]?)?(\d{5,8})(?=$|[^A-Z0-9])/g)) {
    const prefix = match[1];
    const digits = match[2];
    if (!prefix || !digits) continue;
    addCandidate(
      candidates,
      {
        mediaKeyNorm: `${prefix}PPV${digits}`,
        mediaDisplayKey: `${prefix}-PPV-${digits}`,
        evidence: match[0].trim(),
        confidence: 0.92
      }
    );
  }
  return Array.from(candidates.values())
    .sort((a, b) => b.confidence - a.confidence || a.mediaDisplayKey.localeCompare(b.mediaDisplayKey))
    .slice(0, 12);
}

export function extractRurugrabMediaKeyCandidatesForAsset(asset: Pick<AssetRecord, "title" | "description" | "originalName" | "tags">) {
  return extractRurugrabMediaKeyCandidates([asset.title, asset.description, asset.originalName, ...asset.tags].join(" "));
}

export async function lookupRurugrabMetadataForAsset(
  asset: Pick<AssetRecord, "title" | "description" | "originalName" | "tags">,
  now = new Date().toISOString()
): Promise<ExternalMediaMetadata | null> {
  const candidates = extractRurugrabMediaKeyCandidatesForAsset(asset);
  if (candidates.length === 0) return null;

  const explicitDbPath = process.env.RURUGRAB_METADATA_DB_PATH?.trim();
  const dbPath = explicitDbPath || defaultRurugrabMetadataDbPath;
  if (!existsSync(dbPath)) {
    return explicitDbPath ? unavailableMetadata(candidates, now, `Rurugrab metadata DB does not exist: ${dbPath}`) : null;
  }

  try {
    const rows = await queryRurugrabRows(dbPath, candidates);
    if (rows.length === 0) return notFoundMetadata(candidates, now);
    return buildMatchedMetadata(rows, candidates, now);
  } catch (error) {
    return unavailableMetadata(candidates, now, error instanceof Error ? error.message : "Rurugrab metadata lookup failed");
  }
}

export async function enrichAssetWithRurugrabMetadata(asset: AssetRecord, now = new Date().toISOString()) {
  if (asset.externalMetadata?.rurugrab?.status === "matched") return asset;
  const metadata = await lookupRurugrabMetadataForAsset(asset, now);
  if (!metadata) return asset;
  return mergeRurugrabMetadataIntoAsset(asset, metadata, now);
}

export function mergeRurugrabMetadataIntoAsset(asset: AssetRecord, metadata: ExternalMediaMetadata, now = new Date().toISOString()): AssetRecord {
  const trace = rurugrabMetadataTrace(metadata);
  const tags = metadata.status === "matched" ? mergeExternalMetadataTags(asset.tags, metadata) : asset.tags;
  return {
    ...asset,
    tags,
    externalMetadata: {
      ...asset.externalMetadata,
      rurugrab: metadata
    },
    intelligence: {
      ...asset.intelligence,
      modelTrace: trace ? appendTrace(asset.intelligence.modelTrace, trace) : asset.intelligence.modelTrace
    },
    updatedAt: now
  };
}

export function rurugrabMetadataTrace(metadata: ExternalMediaMetadata | null | undefined) {
  if (!metadata) return "";
  if (metadata.status === "matched") {
    return `metadata:rurugrab:matched:${metadata.mediaDisplayKey ?? metadata.mediaKeyNorm ?? "unknown"}:providers=${metadata.providerCount}`;
  }
  return `metadata:rurugrab:${metadata.status}:${metadata.matchReason}`;
}

async function queryRurugrabRows(dbPath: string, candidates: MediaKeyCandidate[]) {
  const normKeys = unique(candidates.map((candidate) => candidate.mediaKeyNorm));
  const displayKeys = unique(candidates.map((candidate) => candidate.mediaDisplayKey));
  const sql = `
    select
      s.media_id,
      s.media_key_norm,
      s.media_display_key,
      s.search_text,
      s.provider_count,
      s.release_date_key,
      p.provider,
      p.title,
      p.payload_json
    from metadata_media_item_summary s
    left join metadata_provider_items p on p.media_key_norm = s.media_key_norm
    where s.media_key_norm in (${sqlStringList(normKeys)})
       or s.media_display_key in (${sqlStringList(displayKeys)})
    order by
      s.provider_count desc,
      s.media_key_norm asc,
      case p.provider
        when 'dmm' then 1
        when 'r18dev' then 2
        when 'javdb' then 3
        when 'javdatabase' then 4
        when 'javstash' then 5
        else 9
      end,
      p.updated_at desc
    limit 64;
  `;
  const { stdout } = await execFileAsync("sqlite3", ["-readonly", "-json", dbPath, sql], { maxBuffer: 8 * 1024 * 1024 });
  if (!stdout.trim()) return [];
  return JSON.parse(stdout) as RurugrabProviderRow[];
}

function buildMatchedMetadata(rows: RurugrabProviderRow[], candidates: MediaKeyCandidate[], now: string): ExternalMediaMetadata {
  const candidateByNorm = new Map(candidates.map((candidate) => [candidate.mediaKeyNorm, candidate]));
  const grouped = groupRowsByMediaKey(rows);
  const best = Array.from(grouped.values()).sort((a, b) => groupScore(b, candidateByNorm) - groupScore(a, candidateByNorm))[0] ?? rows;
  const payloads = best.map((row) => parsePayload(row.payload_json)).filter((payload): payload is JsonRecord => Boolean(payload));
  const providerRows = best.filter((row) => row.provider);
  const primaryRow = providerRows.sort((a, b) => providerCompletenessScore(b, payloads) - providerCompletenessScore(a, payloads))[0] ?? best[0];
  const candidate = candidateByNorm.get(best[0]?.media_key_norm ?? "") ?? candidates[0];
  const metadata: ExternalMediaMetadata = {
    source: "rurugrab",
    status: "matched",
    matchedAt: now,
    matchConfidence: Math.max(candidate?.confidence ?? 0.86, Math.min(0.99, 0.82 + (Number(best[0]?.provider_count ?? 1) * 0.01))),
    matchReason: `product-code:${candidate?.mediaDisplayKey ?? best[0]?.media_display_key ?? "unknown"}`,
    mediaKeyNorm: best[0]?.media_key_norm ?? candidate?.mediaKeyNorm ?? null,
    mediaDisplayKey: best[0]?.media_display_key ?? candidate?.mediaDisplayKey ?? null,
    providerCount: Number(best[0]?.provider_count ?? providerRows.length),
    primaryProvider: primaryRow?.provider ?? firstString(payloads, ["source"]) ?? null,
    title: firstStringFromRowsAndPayloads(best, payloads, ["title", "raw.fields.title"]),
    localizedTitles: unique([...arrayStringsFromPayloads(payloads, ["localized_titles"]), ...arrayStringsFromPayloads(payloads, ["raw.fields.localized_titles"])]),
    titleVariants: unique([...arrayStringsFromPayloads(payloads, ["title_variants"]), ...arrayStringsFromPayloads(payloads, ["raw.fields.title_variants"])]),
    releaseDate: firstString(payloads, ["release_date", "raw.fields.release_date", "raw.fields.published_date"]) ?? releaseDateFromKey(best[0]?.release_date_key),
    runtimeMinutes: firstNumber(payloads, ["runtime_minutes", "raw.fields.runtime", "runtime"]),
    studio: firstString(payloads, ["studio", "raw.fields.studio"]),
    label: firstString(payloads, ["label", "raw.fields.label"]),
    series: firstString(payloads, ["series", "raw.fields.series"]),
    director: firstString(payloads, ["director", "raw.fields.director"]),
    genres: unique([...arrayStringsFromPayloads(payloads, ["genres"]), ...arrayStringsFromPayloads(payloads, ["raw.fields.genres"])]).slice(0, 48),
    performers: unique([...performersFromPayloads(payloads), ...performersFromCredits(best)]).slice(0, 48),
    coverImageUrl: firstString(payloads, ["cover_image_url", "raw.fields.cover_image_url"]),
    previewVideoUrl: firstString(payloads, ["preview_video_url", "raw.fields.preview_video_url", "raw.fields.sample_video_url"]),
    sourceUrls: unique([...urlsFromPayloads(payloads), ...best.map((row) => firstString([parsePayload(row.payload_json)].filter((payload): payload is JsonRecord => Boolean(payload)), ["source_url"]))].filter(Boolean) as string[]),
    externalIds: externalIdsFromPayloads(payloads),
    searchText: ""
  };
  metadata.searchText = externalMetadataToSearchText(metadata);
  return metadata;
}

function groupRowsByMediaKey(rows: RurugrabProviderRow[]) {
  const grouped = new Map<string, RurugrabProviderRow[]>();
  for (const row of rows) {
    const key = row.media_key_norm;
    grouped.set(key, [...(grouped.get(key) ?? []), row]);
  }
  return grouped;
}

function groupScore(rows: RurugrabProviderRow[], candidateByNorm: Map<string, MediaKeyCandidate>) {
  const first = rows[0];
  if (!first) return 0;
  const candidateScore = candidateByNorm.get(first.media_key_norm)?.confidence ?? 0.5;
  return candidateScore * 100 + Number(first.provider_count ?? 0) * 4 + rows.length;
}

function providerCompletenessScore(row: RurugrabProviderRow, _payloads: JsonRecord[]) {
  const payload = parsePayload(row.payload_json);
  if (!payload) return 0;
  return [
    row.title,
    valueAtPath(payload, "release_date"),
    valueAtPath(payload, "runtime_minutes"),
    valueAtPath(payload, "studio"),
    valueAtPath(payload, "label"),
    valueAtPath(payload, "series"),
    valueAtPath(payload, "director"),
    valueAtPath(payload, "cover_image_url"),
    valueAtPath(payload, "preview_video_url")
  ].filter(Boolean).length;
}

function notFoundMetadata(candidates: MediaKeyCandidate[], now: string): ExternalMediaMetadata {
  const candidate = candidates[0];
  return emptyMetadata("not_found", now, `product-code candidates not found: ${candidates.map((item) => item.mediaDisplayKey).join(", ")}`, candidate);
}

function unavailableMetadata(candidates: MediaKeyCandidate[], now: string, reason: string): ExternalMediaMetadata {
  return emptyMetadata("unavailable", now, reason, candidates[0]);
}

function emptyMetadata(status: ExternalMediaMetadata["status"], now: string, reason: string, candidate?: MediaKeyCandidate): ExternalMediaMetadata {
  return {
    source: "rurugrab",
    status,
    matchedAt: now,
    matchConfidence: 0,
    matchReason: reason,
    mediaKeyNorm: candidate?.mediaKeyNorm ?? null,
    mediaDisplayKey: candidate?.mediaDisplayKey ?? null,
    providerCount: 0,
    primaryProvider: null,
    title: null,
    localizedTitles: [],
    titleVariants: [],
    releaseDate: null,
    runtimeMinutes: null,
    studio: null,
    label: null,
    series: null,
    director: null,
    genres: [],
    performers: [],
    coverImageUrl: null,
    previewVideoUrl: null,
    sourceUrls: [],
    externalIds: {},
    searchText: candidate ? `${candidate.mediaDisplayKey} ${candidate.mediaKeyNorm}` : ""
  };
}

function addMediaKeyCandidate(candidates: Map<string, MediaKeyCandidate>, prefix: string, digits: string, evidence: string, confidence: number) {
  addCandidate(candidates, {
    mediaKeyNorm: `${prefix}${digits}`,
    mediaDisplayKey: `${prefix}-${digits}`,
    evidence,
    confidence
  });
}

function addCandidate(candidates: Map<string, MediaKeyCandidate>, candidate: MediaKeyCandidate) {
  const existing = candidates.get(candidate.mediaKeyNorm);
  if (!existing || candidate.confidence > existing.confidence) candidates.set(candidate.mediaKeyNorm, candidate);
}

function digitVariants(digits: string) {
  const variants = new Set([digits]);
  if (/^0{2,}\d+$/.test(digits)) {
    const stripped = digits.replace(/^0+/, "");
    if (stripped.length > 0) variants.add(stripped.padStart(Math.min(3, Math.max(2, stripped.length)), "0"));
  }
  return Array.from(variants);
}

function parsePayload(payload: string | null): JsonRecord | null {
  if (!payload) return null;
  try {
    const parsed = JSON.parse(payload) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as JsonRecord) : null;
  } catch {
    return null;
  }
}

function firstStringFromRowsAndPayloads(rows: RurugrabProviderRow[], payloads: JsonRecord[], paths: string[]) {
  return firstString(payloads, paths) ?? rows.map((row) => cleanString(row.title)).find(Boolean) ?? null;
}

function firstString(payloads: JsonRecord[], paths: string[]) {
  for (const payload of payloads) {
    for (const path of paths) {
      const stringValue = cleanString(valueAtPath(payload, path));
      if (stringValue) return stringValue;
    }
  }
  return null;
}

function firstNumber(payloads: JsonRecord[], paths: string[]) {
  for (const payload of payloads) {
    for (const path of paths) {
      const value = valueAtPath(payload, path);
      const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value.replace(/[^\d.]/g, "")) : NaN;
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
  }
  return null;
}

function arrayStringsFromPayloads(payloads: JsonRecord[], paths: string[]) {
  return payloads.flatMap((payload) => paths.flatMap((path) => stringsFromValue(valueAtPath(payload, path))));
}

function performersFromPayloads(payloads: JsonRecord[]) {
  return unique([
    ...arrayStringsFromPayloads(payloads, ["performers", "raw.fields.performers"]),
    ...payloads.flatMap((payload) => {
      const credits = valueAtPath(payload, "credits");
      if (!Array.isArray(credits)) return [];
      return credits.flatMap((credit) => {
        if (!credit || typeof credit !== "object") return [];
        const record = credit as JsonRecord;
        const role = cleanString(record.role)?.toLowerCase() ?? "";
        if (role && !/(performer|actor|actress)/i.test(role)) return [];
        return cleanString(record.person_name) ?? cleanString(record.name) ?? [];
      });
    })
  ]);
}

function performersFromCredits(rows: RurugrabProviderRow[]) {
  return unique(
    rows.flatMap((row) => {
      const payload = parsePayload(row.payload_json);
      if (!payload) return [];
      return performersFromPayloads([payload]);
    })
  );
}

function urlsFromPayloads(payloads: JsonRecord[]) {
  return unique(
    payloads.flatMap((payload) => [
      ...stringsFromValue(valueAtPath(payload, "source_url")),
      ...stringsFromValue(valueAtPath(payload, "raw.fields.url")),
      ...urlsFromUrlObjects(valueAtPath(payload, "_urls"))
    ])
  );
}

function urlsFromUrlObjects(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    return cleanString((item as JsonRecord).url) ?? [];
  });
}

function externalIdsFromPayloads(payloads: JsonRecord[]) {
  const externalIds: ExternalMediaMetadata["externalIds"] = {};
  for (const payload of payloads) {
    const value = valueAtPath(payload, "external_ids");
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    for (const [key, raw] of Object.entries(value as JsonRecord)) {
      if (typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean" || raw === null) {
        externalIds[key] = raw;
      }
    }
  }
  return externalIds;
}

function stringsFromValue(value: unknown): string[] {
  if (Array.isArray(value)) return unique(value.map(cleanString).filter(Boolean) as string[]);
  if (value && typeof value === "object") return unique(Object.values(value as JsonRecord).flatMap(stringsFromValue));
  const cleaned = cleanString(value);
  return cleaned ? [cleaned] : [];
}

function valueAtPath(record: JsonRecord, path: string): unknown {
  return path.split(".").reduce<unknown>((value, key) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    return (value as JsonRecord)[key];
  }, record);
}

function releaseDateFromKey(value: number | null | undefined) {
  if (!value) return null;
  const text = String(value);
  if (!/^\d{8}$/.test(text)) return null;
  return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
}

function sqlStringList(values: string[]) {
  return values.length > 0 ? values.map(sqlString).join(",") : "''";
}

function sqlString(value: string) {
  return `'${value.replace(/'/g, "''")}'`;
}

function cleanString(value: unknown) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const cleaned = String(value).normalize("NFKC").replace(/\s+/g, " ").trim();
  return cleaned.length > 0 ? cleaned : null;
}

function unique(values: string[]) {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const cleaned = cleanString(value);
    if (!cleaned) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(cleaned);
  }
  return result;
}

function appendTrace(traces: string[], trace: string) {
  const group = trace.split(":").slice(0, 3).join(":");
  return [...traces.filter((item) => item.split(":").slice(0, 3).join(":") !== group), trace];
}
