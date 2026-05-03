export function mediaPath(value: string) {
  if (!value || value.startsWith("/")) return null;
  if (value.startsWith("http://") || value.startsWith("https://")) return value;
  return `/media/${value.split("/").map(encodeURIComponent).join("/")}`;
}

export function formatDuration(seconds: number) {
  const safe = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(safe / 60);
  const rest = safe % 60;
  return `${minutes}:${rest.toString().padStart(2, "0")}`;
}

export function splitSearchEvidence(transcript: string, fallback: string, query: string) {
  const cleaned = transcript.replace(/\s+/g, " ").trim();
  if (!cleaned) return { asr: fallback, ocr: "" };
  const ocrMatch = cleaned.match(/\s+OCR(?:\s+(?:subtitle|screen|overlay))?:\s+/);
  if (!ocrMatch || ocrMatch.index === undefined) return { asr: truncateText(cleaned, 150), ocr: "" };
  const asrPart = cleaned.slice(0, ocrMatch.index);
  const ocrPart = cleaned
    .slice(ocrMatch.index)
      .replace(/\s*OCR(?:\s+(subtitle|screen|overlay))?:\s*/g, (_match, role) => (role ? ` | ${role}: ` : " | "))
      .replace(/^\s*\|\s*/, "")
      .trim();
  const asr = truncateText(asrPart.trim() || fallback, 150);
  const ocr = shouldShowOcrEvidence(ocrPart, asrPart, query) ? truncateText(ocrPart.replace(/\.$/, ""), 120) : "";
  return { asr, ocr };
}

function shouldShowOcrEvidence(ocr: string, asr: string, query: string) {
  const cleaned = ocr.replace(/\s+/g, " ").trim();
  if (!cleaned) return false;
  const normalized = cleaned.toLowerCase();
  const boilerplatePatterns = [/이\s*영상(?:엔|에는)?\s*생성형/i, /생성형\s*(?:a|ai)\s*기술/i, /기술이\s*사용\s*되었/i];
  if (boilerplatePatterns.some((pattern) => pattern.test(normalized))) return false;
  const terms = queryTermsForDisplay(query);
  if (terms.length === 0) return !asr.trim();
  const hasQueryHit = terms.some((term) => normalized.includes(term.toLowerCase()));
  return hasQueryHit || !asr.trim();
}

function queryTermsForDisplay(query: string) {
  return Array.from(
    new Set(
      query
        .toLowerCase()
        .replace(/[^a-z0-9가-힣\s-]/g, " ")
        .split(/\s+/)
        .map((term) => term.trim().replace(/^-+|-+$/g, ""))
        .filter((term) => (/[가-힣]/.test(term) ? term.length >= 2 : term.length > 2))
    )
  );
}

export function truncateText(value: string, limit: number) {
  return value.length > limit ? `${value.slice(0, limit)}...` : value;
}
