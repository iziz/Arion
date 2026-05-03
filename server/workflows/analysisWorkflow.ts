import { analyzeAsset } from "../intelligence";
import { deliverEvent, recordBilling, recordEvent } from "../services/events";
import type { AssetRecord } from "../../shared/types";

export async function analyzeAndEmit(asset: AssetRecord, question: string) {
  if (asset.status !== "indexed") {
    throw Object.assign(new Error("Asset is not indexed yet"), { statusCode: 409 });
  }
  const result = await analyzeAsset(asset, question);
  const event = await recordEvent("analysis.completed", "Analysis completed", {
    indexId: asset.indexId,
    assetId: asset.id,
    payload: { question, signals: result.signals }
  });
  await deliverEvent("analysis.completed", event);
  await recordBilling(asset.id, null, 1, "local analysis request");
  return result;
}
