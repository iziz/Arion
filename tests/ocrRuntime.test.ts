import assert from "node:assert/strict";
import test from "node:test";
import { inferPaddleOcrLanguages } from "../server/localModelRuntime";
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

test("PaddleOCR language follows detected ASR language without English fallback", () => {
  withPaddleOcrLang(undefined, () => {
    assert.deepEqual(inferPaddleOcrLanguages(ocrLanguageAsset("unknown"), "ko"), ["korean"]);
    assert.deepEqual(inferPaddleOcrLanguages(ocrLanguageAsset("unknown"), "en"), ["en"]);
  });
});

test("PaddleOCR falls back to metadata script only when ASR language is unknown", () => {
  withPaddleOcrLang(undefined, () => {
    assert.deepEqual(inferPaddleOcrLanguages(ocrLanguageAsset("unknown", "한국어 자막 영상")), ["korean"]);
  });
});

test("PaddleOCR explicit language config overrides ASR language", () => {
  withPaddleOcrLang("ko", () => {
    assert.deepEqual(inferPaddleOcrLanguages(ocrLanguageAsset("en"), "en"), ["korean"]);
  });
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

function ocrLanguageAsset(asrLanguage: string, title = "Untitled") {
  return {
    title,
    description: "",
    originalName: "video.mp4",
    intelligence: {
      asr: {
        language: asrLanguage
      }
    }
  };
}

function withPaddleOcrLang(value: string | undefined, callback: () => void) {
  const previous = process.env.PADDLEOCR_LANG;
  if (value === undefined) {
    delete process.env.PADDLEOCR_LANG;
  } else {
    process.env.PADDLEOCR_LANG = value;
  }
  try {
    callback();
  } finally {
    if (previous === undefined) {
      delete process.env.PADDLEOCR_LANG;
    } else {
      process.env.PADDLEOCR_LANG = previous;
    }
  }
}
