const mojibakeMarkers = /[ÃÂâ]|[\u0080-\u009f]/;

export function normalizeUploadedText(value: unknown) {
  return normalizePossiblyMojibake(String(value ?? ""));
}

export function normalizePossiblyMojibake(value: string) {
  const normalized = value.normalize("NFC");
  if (!shouldTryLatin1Repair(normalized)) return normalized;
  const repaired = Buffer.from(normalized, "latin1").toString("utf8").normalize("NFC");
  return textQualityScore(repaired) > textQualityScore(normalized) ? repaired : normalized;
}

function shouldTryLatin1Repair(value: string) {
  return mojibakeMarkers.test(value);
}

function textQualityScore(value: string) {
  let score = 0;
  for (const char of value) {
    if (/[\uac00-\ud7af]/u.test(char)) score += 4;
    else if (/[\u4e00-\u9fff]/u.test(char)) score += 3;
    else if (/[\u3130-\u318f\u1100-\u11ff]/u.test(char)) score += 1;
    else if (/[A-Za-z0-9]/u.test(char)) score += 1;
    else if (char === "\uFFFD") score -= 12;
    else if (/[\u0080-\u009f]/u.test(char)) score -= 8;
    else if (/[ÃÂâ]/u.test(char)) score -= 4;
  }
  return score;
}
