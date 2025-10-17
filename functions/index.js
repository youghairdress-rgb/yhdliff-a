const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");
const { VertexAI } = require("@google-cloud/vertexai");

admin.initializeApp();
const db = admin.firestore();
const GEMINI_KEY = defineSecret("GEMINI_KEY");

// ★★★★★ お客様ご指定の構成 ★★★★★
const functionOptions = {
  secrets: [GEMINI_KEY],
  region: "asia-northeast1", // 東京リージョン
  memory: "1GiB",
};

// 画像URLからGenerative Partを生成するヘルパー関数を共通化
const urlToGenerativePart = async (url, mimeType) => {
  const response = await fetch(url);
  if (!response.ok) {
    throw new HttpsError("internal", `画像の取得に失敗しました: ${url}`);
  }
  const buffer = await response.arrayBuffer();
  return { inlineData: { data: Buffer.from(buffer).toString("base64"), mimeType } };
};

// AIによるパーソナル診断を行う関数
exports.generateDiagnosis = onCall({ ...functionOptions, timeoutSeconds: 240 }, async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "認証が必要です。");
  }
  const userId = request.auth.uid;
  const userDoc = await db.collection("users").doc(userId).get();
  if (!userDoc.exists) {
    throw new HttpsError("not-found", "ユーザーデータが見つかりません。");
  }
  const imageUrls = userDoc.data().uploads || {};
  if (!imageUrls.frontImage || !imageUrls.sideImage || !imageUrls.backImage) {
    throw new HttpsError("invalid-argument", "診断に必要な画像が不足しています。");
  }

  // Vertex AI SDK を使用してクライアントを初期化します。
  // Cloud Functions環境では、サービスアカウントによって自動的に認証されます。
  const vertex_ai = new VertexAI({
    project: process.env.GCLOUD_PROJECT,
    location: "asia-northeast1",
  });
  const model = vertex_ai.getGenerativeModel({ model: "gemini-1.5-flash-001", generationConfig: { responseMimeType: "application/json" } });

  const systemPrompt = `あなたは、最新の美容トレンドと専門知識を兼ね備えた「AIトップヘアスタイリスト」兼「パーソナルアナリスト」です。ユーザーから提供される複数の画像情報を基に、顔、骨格、パーソナルカラー、髪質を総合的に分析し、ユーザーの魅力を最大限に引き出すための具体的な提案（ヘアスタイル、カラー、メイク、ファッション）を生成してください。全ての分析結果と提案を、指定された厳密なJSON形式で出力してください。これがあなたの最終成果物です。ネガティブな表現は避け、個性をチャームポイントとして捉え、ポジティブな提案を行ってください。出力JSON形式: { "analysis": { "face": { "鼻": "分析結果", "口": "分析結果", "目": "分析結果", "眉": "分析結果", "おでこ": "分析結果" }, "skeleton": { "首の長さ": "分析結果", "顔の形": "分析結果", "ボディライン": "分析結果", "肩のライン": "分析結果" }, "personal_color": { "ベースカラー": "分析結果", "シーズン": "分析結果", "明度": "分析結果", "彩度": "分析結果", "瞳の色": "分析結果" }, "hair": { "クセ": "分析結果", "ボリューム感": "分析結果", "現在の明度": "分析結果", "損傷度合い": "分析結果" } }, "proposals": { "hairstyles": [ { "name": "提案名", "description": "50～100字の説明" }, { "name": "提案名", "description": "50～100字の説明" } ], "hair_colors": [ { "name": "提案名", "description": "50～100字の説明" }, { "name": "提案名", "description": "50～100字の説明" } ], "makeup": { "リップカラー": "提案", "アイシャドウ": "提案", "チーク": "提案", "ファンデーション": "提案" }, "fashion": { "基本カラー": "提案", "差し色": "提案", "素材": "提案", "シルエット": "提案" }, "overall_comment": "200～300字の総評" }, "image_generation_prompts": { "style_1": "masterpiece, best quality, photorealistic hair, medium length layered cut, ash beige color, see-through bangs, soft and airy texture, reflecting soft natural daylight from the front", "style_2": "masterpiece, best quality, ultra realistic, beautiful short bob, coral pink color, glossy and sleek texture, reflecting bright studio lighting" } }`;
  const prompt = "これらの画像から、指示通りに完全なJSONを生成してください。JSON以外のテキストは絶対に含めないでください。";

  try {
    // --- 修正点: 重複していた関数定義を削除 ---
    // グローバルスコープの urlToGenerativePart が使用されるようになります。
    const imageParts = await Promise.all([
      urlToGenerativePart(imageUrls.frontImage, "image/jpeg"),
      urlToGenerativePart(imageUrls.sideImage, "image/jpeg"),
      urlToGenerativePart(imageUrls.backImage, "image/jpeg"),
    ]);
 
    // Vertex AI SDK の generateContent メソッドの正しい形式に修正
    const result = await model.generateContent({ contents: [{ role: "user", parts: [{ text: systemPrompt }, ...imageParts, { text: prompt }] }] });
    // responseMimeType: "application/json" を指定したため、直接JSONとして扱えます
    return result.response.candidates[0].content.parts[0].text;
  } catch (error) {
    console.error("Gemini API Error (Diagnosis):", error);
    throw new HttpsError("internal", "AI診断中にエラーが発生しました。", { details: error.message });
  }
});

// 画像生成を行う関数
exports.generateImage = onCall({ ...functionOptions, timeoutSeconds: 300 }, async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "認証が必要です。");
  }

  const { prompt, originalImageUrl } = request.data;
  if (!prompt || !originalImageUrl) {
    throw new HttpsError("invalid-argument", "画像生成に必要な情報が不足しています。");
  }
  
  // Vertex AI SDK を使用してクライアントを初期化
  const vertex_ai = new VertexAI({
    project: process.env.GCLOUD_PROJECT,
    location: "asia-northeast1",
  });
  // 画像生成には imagegeneration@006 (Imagen 2) のような専用モデルが推奨されます
  const imagenModel = vertex_ai.getGenerativeModel({ model: "imagegeneration@006" });

  try {
    const originalImagePart = await urlToGenerativePart(originalImageUrl, "image/jpeg");

    // Vertex AI SDK (Imagen) の generateContent メソッドの正しい形式に修正
    const result = await imagenModel.generateContent({
      contents: [{
        parts: [{ text: prompt }, originalImagePart]
      }]
    });
    const response = result.response;

    const imagePart = response.candidates[0].content.parts.find((part) => part.inlineData);
    if (!imagePart) {
      throw new HttpsError("internal", "画像データの取得に失敗しました。");
    }
    const base64Data = imagePart.inlineData.data;

    return { base64Image: base64Data };
  } catch (error) {
    console.error("Gemini API Error (Image Generation):", error);
    throw new HttpsError("internal", "画像生成中にエラーが発生しました。", { details: error.message });
  }
});
