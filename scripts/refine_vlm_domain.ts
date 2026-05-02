import "../server/env";
import { buildDomainSegmentIndex } from "../server/domainIndex";
import { embedTimelineSegments } from "../server/localEmbeddingRuntime";
import { refineSportsDomainTimelineWithVlm } from "../server/vlmWorkerClient";
import { upsertAssetVectors } from "../server/localVectorStore";
import { upsertAssetTracking } from "../server/trackingStore";
import { createDefaultIndex, listAssets, listIndexes, saveAsset } from "../server/store";
import type { AssetRecord, IndexRecord, TimelineSegment } from "../shared/types";

async function main() {
  const [assets, indexes] = await Promise.all([listAssets(), listIndexes()]);
  const indexedAssets = assets.filter((asset) => asset.timeline.length > 0);
  console.log(`Found ${indexedAssets.length} indexed assets with timelines.`);
  for (const asset of indexedAssets) {
    const index = indexes.find((item) => item.id === asset.indexId) ?? createDefaultIndex();
    if (!index.domainIndexing?.enabled || !index.domainIndexing.groups.includes("sports.football")) {
      console.log(`skip ${asset.id} ${asset.title} - sports domain indexing is disabled`);
      continue;
    }
    console.log(`refine ${asset.id} ${asset.title}`);
    const domainTimeline = ensureDomainTimeline(asset, index);
    const refined = await refineSportsDomainTimelineWithVlm({ ...asset, timeline: domainTimeline }, index, domainTimeline);
    const embeddedTimeline = await embedTimelineSegments(refined.timeline);
    const nextAsset: AssetRecord = {
      ...asset,
      timeline: embeddedTimeline,
      status: "indexed",
      progress: 100,
      error: null,
      intelligence: {
        ...asset.intelligence,
        modelTrace: [
          ...asset.intelligence.modelTrace.filter((trace) => !trace.startsWith("domain-vlm-refine:")),
          `domain-vlm-refine:${refined.model}:${refined.refinedSegments}/${refined.attemptedSegments}:invalid=${refined.invalidSegments}:failed=${refined.failedSegments}`
        ]
      },
      updatedAt: new Date().toISOString()
    };
    await saveAsset(nextAsset);
    await upsertAssetVectors(index.id, asset.id, embeddedTimeline);
    await upsertAssetTracking(nextAsset);
    console.log(`done ${asset.id} refined=${refined.refinedSegments}/${refined.attemptedSegments} errors=${refined.errors.length}`);
    for (const error of refined.errors.slice(0, 3)) console.log(`  ${error}`);
  }
}

function ensureDomainTimeline(asset: AssetRecord, index: IndexRecord): TimelineSegment[] {
  const assetWithTimeline = { ...asset, timeline: asset.timeline };
  return asset.timeline.map((segment) => {
    const domain = segment.domain ?? buildDomainSegmentIndex(assetWithTimeline, index, segment);
    if (!domain) return segment;
    return {
      ...segment,
      domain,
      sources: Array.from(new Set([...segment.sources, "domain" as const]))
    };
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
