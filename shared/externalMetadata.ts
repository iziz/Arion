import type { AssetRecord, ExternalMediaMetadata } from "./types";

export function externalMetadataSearchText(asset: Pick<AssetRecord, "externalMetadata">) {
  const metadata = asset.externalMetadata?.rurugrab;
  if (!metadata || metadata.status !== "matched") return "";
  return metadata.searchText || externalMetadataToSearchText(metadata);
}

export function externalMetadataTags(metadata: ExternalMediaMetadata | null | undefined) {
  if (!metadata || metadata.status !== "matched") return [];
  return uniqueClean([
    metadata.mediaDisplayKey,
    metadata.mediaKeyNorm,
    metadata.studio,
    metadata.label,
    metadata.series,
    metadata.director,
    metadata.primaryProvider ? `provider:${metadata.primaryProvider}` : "",
    "metadata:rurugrab",
    ...metadata.performers.slice(0, 12),
    ...metadata.genres.slice(0, 12),
    ...Object.values(metadata.externalIds).map((value) => (value == null ? "" : String(value)))
  ]).slice(0, 32);
}

export function externalMetadataToSearchText(metadata: ExternalMediaMetadata) {
  return uniqueClean([
    metadata.mediaDisplayKey,
    metadata.mediaKeyNorm,
    metadata.title,
    ...metadata.localizedTitles,
    ...metadata.titleVariants,
    metadata.releaseDate,
    metadata.runtimeMinutes == null ? "" : `${metadata.runtimeMinutes} minutes`,
    metadata.studio,
    metadata.label,
    metadata.series,
    metadata.director,
    ...metadata.genres,
    ...metadata.performers,
    metadata.primaryProvider,
    ...metadata.sourceUrls,
    ...Object.entries(metadata.externalIds).flatMap(([key, value]) => [key, value == null ? "" : String(value)])
  ]).join(" ");
}

export function mergeExternalMetadataTags(tags: string[], metadata: ExternalMediaMetadata | null | undefined) {
  return uniqueClean([...tags, ...externalMetadataTags(metadata)]).slice(0, 48);
}

function uniqueClean(values: Array<string | null | undefined>) {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const cleaned = cleanMetadataTerm(value);
    if (!cleaned) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(cleaned);
  }
  return result;
}

function cleanMetadataTerm(value: string | null | undefined) {
  return (value ?? "")
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim();
}
