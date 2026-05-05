import assert from "node:assert/strict";
import test from "node:test";
import { selectBestPaddleOcrResult, type PaddleResult } from "../server/modelRuntime/ocrRuntime";

test("Korean OCR candidate wins over high-volume English OCR noise when Hangul is present", () => {
  const selected = selectBestPaddleOcrResult(
    [
      paddleResult("en", [
        "SHAALL",
        "TEKLTHELI",
        "UZHQ1",
        "5/91407",
        "TOMZH",
        "2DILDI",
        "TH3 HOHOR t EI2I",
        "FMAI",
        "214171",
        "UZ4Q1"
      ]),
      paddleResult("korean", ["못 참겠다ㅋㅋㅋ", "생일 축하합니다"])
    ],
    ["korean", "en"]
  );

  assert.equal(selected.language, "korean");
});

function paddleResult(language: string, texts: string[]): PaddleResult {
  return {
    available: true,
    provider: "paddleocr",
    language,
    tokens: texts,
    confidence: language === "en" ? 0.68 : 0.51,
    frames: [
      {
        framePath: `/tmp/${language}.png`,
        at: 0,
        tokens: texts,
        confidence: language === "en" ? 0.68 : 0.51,
        boxes: texts.map((text) => ({
          text,
          confidence: language === "en" ? 0.68 : 0.51,
          bbox: [],
          region: "bottom",
          role: "subtitle"
        }))
      }
    ]
  };
}
