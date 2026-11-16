const express = require("express");
const path = require("path");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.join(__dirname, "public")));

const MODEL = process.env.GEMINI_MODEL || "gemini-3.8-flash";
let aiClient = null;

// =====================================================
// 请求统计与本地缓存
// 注意：Render 重启后，内存统计和缓存会清零。
// =====================================================

const requestStats = {
  geminiCalls: 0,
  cacheHits: 0,
  failures: 0,
  startedAt: new Date().toISOString()
};

const responseCache = new Map();
const CACHE_TTL = 30 * 60 * 1000;
const CACHE_MAX = 100;

function makeCacheKey(route, body) {
  return crypto
    .createHash("sha256")
    .update(MODEL + "|" + route + "|" + JSON.stringify(body || {}))
    .digest("hex");
}

function getCached(key) {
  const item = responseCache.get(key);
  if (!item) return null;

  if (Date.now() - item.time > CACHE_TTL) {
    responseCache.delete(key);
    return null;
  }

  requestStats.cacheHits++;
  return item.value;
}

function setCached(key, value) {
  if (responseCache.size >= CACHE_MAX) {
    const oldestKey = responseCache.keys().next().value;
    if (oldestKey) responseCache.delete(oldestKey);
  }

  responseCache.set(key, {
    time: Date.now(),
    value
  });
}

// =====================================================
// Gemini 初始化
// =====================================================

async function getAI() {
  if (aiClient) return aiClient;

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("Render 环境变量中没有设置 GEMINI_API_KEY");
  }

  const { GoogleGenAI } = await import("@google/genai");
  aiClient = new GoogleGenAI({ apiKey });
  return aiClient;
}

// =====================================================
// 基础工具
// =====================================================

function cleanText(value, maxLength = 5000) {
  return String(value ?? "")
    .replace(/\u0000/g, "")
    .trim()
    .slice(0, maxLength);
}

function parseModelJson(text) {
  if (!text) throw new Error("AI 没有返回内容");

  let content = String(text)
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  try {
    return JSON.parse(content);
  } catch (_) {
    const start = content.indexOf("{");
    const end = content.lastIndexOf("}");

    if (start !== -1 && end > start) {
      return JSON.parse(content.slice(start, end + 1));
    }
  }

  throw new Error("AI 返回的数据不是有效 JSON，请重新生成");
}

function errorCode(error) {
  return String(
    error?.status ||
    error?.code ||
    error?.message ||
    error ||
    ""
  ).toLowerCase();
}

function isRateLimitError(error) {
  const value = errorCode(error);
  return value.includes("429") ||
    value.includes("resource_exhausted") ||
    value.includes("quota") ||
    value.includes("rate limit");
}

function isRetryableServerError(error) {
  const value = errorCode(error);
  return !isRateLimitError(error) && [
    "503",
    "unavailable",
    "high demand",
    "500",
    "internal server error",
    "502",
    "504"
  ].some(x => value.includes(x));
}

// 429 额度错误绝不重试，避免浪费请求。
// 只有 500/502/503/504 等短暂服务错误最多额外重试一次。
async function generateWithRetry(ai, request) {
  const maxAttempts = 2;
  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      requestStats.geminiCalls++;

      console.log(
        `Gemini 实际请求：第 ${attempt}/${maxAttempts} 次，模型：${MODEL}`
      );

      const response = await ai.models.generateContent({
        model: MODEL,
        ...request
      });

      if (!response || !response.text) {
        throw new Error("Gemini 返回了空内容");
      }

      return response;
    } catch (error) {
      lastError = error;
      requestStats.failures++;

      console.error(
        `Gemini 请求失败：${error?.message || error}`
      );

      if (
        isRateLimitError(error) ||
        !isRetryableServerError(error) ||
        attempt === maxAttempts
      ) {
        throw error;
      }

      const waitTime = 1500;
      console.log(`${waitTime} 毫秒后进行一次服务错误重试`);
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }
  }

  throw lastError || new Error("Gemini 请求失败");
}

function errorResponse(res, error) {
  console.error("AI 请求失败：", error);

  const message = String(error?.message || "未知错误");
  let status = 500;
  let userMessage = message;

  if (isRateLimitError(error)) {
    status = 429;
    userMessage =
      "Gemini 免费额度或请求频率已达到上限。本次不会自动重试，以免继续浪费请求。请等待额度恢复，或检查 Google AI Studio 的配额与计费设置。";
  } else if (isRetryableServerError(error)) {
    status = 503;
    userMessage =
      "Gemini 服务暂时繁忙，系统已进行一次有限重试，请稍后再试。";
  }

  return res.status(status).json({
    ok: false,
    error: userMessage,
    detail: message,
    model: MODEL
  });
}

async function runCachedJSON(route, body, res, generator) {
  const key = makeCacheKey(route, body);
  const cached = getCached(key);

  if (cached) {
    return res.json({
      ...cached,
      cached: true,
      cacheMessage: "命中本地缓存，没有再次调用 Gemini"
    });
  }

  const result = await generator();
  setCached(key, result);
  return res.json({
    ...result,
    cached: false
  });
}

// =====================================================
// 数据标准化
// =====================================================

function normalizeCharacter(c = {}) {
  return {
    name: cleanText(c.name, 80),
    age: cleanText(c.age, 30),
    gender: cleanText(c.gender, 20),
    height: cleanText(c.height, 30),
    identity: cleanText(c.identity, 300),
    mood: cleanText(c.mood, 300),
    look: cleanText(c.look, 500),
    hair: cleanText(c.hair, 300),
    clothes: cleanText(c.clothes, 500),
    props: cleanText(c.props, 300),
    extra: cleanText(c.extra, 500),
    outfitVersions: Array.isArray(c.outfitVersions)
      ? c.outfitVersions.slice(0, 20).map(v => ({
          name: cleanText(v.name, 100),
          description: cleanText(v.description, 800),
          usage: cleanText(v.usage, 300)
        }))
      : []
  };
}

function normalizePeople(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, 40)
    .map(normalizeCharacter)
    .filter(c => c.name);
}

function normalizeScenes(list) {
  if (!Array.isArray(list)) return [];

  return list.slice(0, 40).map(s => ({
    id: cleanText(s.id, 100),
    name: cleanText(s.name, 100),
    type: cleanText(s.type, 100),
    time: cleanText(s.time, 100),
    desc: cleanText(s.desc, 1200),
    layout: cleanText(s.layout, 1500),
    lighting: cleanText(s.lighting, 1000),
    colors: cleanText(s.colors, 500),
    continuity: cleanText(s.continuity, 1000)
  })).filter(s => s.name);
}

function normalizeProps(list) {
  if (!Array.isArray(list)) return [];

  return list.slice(0, 60).map(p => ({
    id: cleanText(p.id, 100),
    name: cleanText(p.name, 100),
    type: cleanText(p.type, 100),
    description: cleanText(p.description || p.desc, 1500),
    material: cleanText(p.material, 300),
    color: cleanText(p.color, 300),
    size: cleanText(p.size, 200),
    usage: cleanText(p.usage, 500),
    owner: cleanText(p.owner, 200),
    continuity: cleanText(p.continuity, 1000)
  })).filter(p => p.name);
}

function normalizeShots(list) {
  if (!Array.isArray(list)) return [];

  return list.slice(0, 60).map((s, index) => ({
    shotNumber: Number(s.shotNumber) || index + 1,
    duration: Number(s.duration) || 0,
    shotTitle: cleanText(s.shotTitle, 200),
    sceneName: cleanText(s.sceneName, 200),
    characters: Array.isArray(s.characters)
      ? s.characters.map(x => cleanText(x, 80)).filter(Boolean)
      : [],
    props: Array.isArray(s.props)
      ? s.props.map(x => cleanText(
          typeof x === "string" ? x : x?.name,
          100
        )).filter(Boolean)
      : [],
    visual: cleanText(s.visual, 3000),
    action: cleanText(s.action, 3000),
    dialogue: cleanText(s.dialogue, 2000),
    camera: cleanText(s.camera, 2000),
    audio: cleanText(s.audio, 1000),
    continuity: cleanText(s.continuity, 2000),
    videoPrompt: cleanText(s.videoPrompt, 6000),
    imagePrompt: cleanText(s.imagePrompt, 8000),
    assetRefs: {
      characters: Array.isArray(s.assetRefs?.characters)
        ? s.assetRefs.characters.slice(0, 20)
        : [],
      scenes: Array.isArray(s.assetRefs?.scenes)
        ? s.assetRefs.scenes.slice(0, 10)
        : [],
      props: Array.isArray(s.assetRefs?.props)
        ? s.assetRefs.props.slice(0, 20)
        : []
    }
  }));
}

function normalizeKeyMoments(list) {
  if (!Array.isArray(list)) return [];

  return list.slice(0, 60).map((item, index) => ({
    id: cleanText(item.id, 100) || `moment-${index + 1}`,
    title: cleanText(item.title, 200),
    sceneName: cleanText(item.sceneName, 100),
    characters: Array.isArray(item.characters)
      ? item.characters.map(x => cleanText(x, 80)).filter(Boolean)
      : [],
    props: Array.isArray(item.props)
      ? item.props.map(x => cleanText(x, 100)).filter(Boolean)
      : [],
    description: cleanText(item.description, 2000),
    emotion: cleanText(item.emotion, 500),
    visualFocus: cleanText(item.visualFocus, 1000)
  }));
}

function normalizePrompts(list) {
  if (!Array.isArray(list)) return [];

  const categories = [
    "character", "scene", "prop", "keyframe", "storyboard"
  ];
  const assetTypes = [
    "character", "scene", "prop", "keyframe"
  ];

  return list.slice(0, 150).map((item, index) => {
    const refs = item.assetRefs || {};
    const category = categories.includes(item.category)
      ? item.category
      : "keyframe";

    return {
      id: cleanText(item.id, 100) ||
        `prompt-${Date.now()}-${index + 1}`,
      category,
      assetType: assetTypes.includes(item.assetType)
        ? item.assetType
        : (assetTypes.includes(category) ? category : "keyframe"),
      assetName: cleanText(item.assetName, 200),
      view: cleanText(item.view, 100),
      shotNumber: Number(item.shotNumber) || 0,
      title: cleanText(item.title, 200) || `生图提示词${index + 1}`,
      subject: cleanText(item.subject, 200),
      purpose: cleanText(item.purpose, 500),
      prompt: cleanText(item.prompt, 12000),
      referenceGuide: cleanText(item.referenceGuide, 3000),
      consistency: cleanText(item.consistency, 3000),
      negativePrompt: cleanText(item.negativePrompt, 3000),
      aspectRatio: cleanText(item.aspectRatio, 30) || "16:9",
      assetRefs: {
        characters: Array.isArray(refs.characters)
          ? refs.characters.map(x => cleanText(x, 100)).filter(Boolean)
          : [],
        scenes: Array.isArray(refs.scenes)
          ? refs.scenes.map(x => cleanText(x, 100)).filter(Boolean)
          : [],
        props: Array.isArray(refs.props)
          ? refs.props.map(x => cleanText(x, 100)).filter(Boolean)
          : []
      }
    };
  }).filter(item => item.prompt);
}

// =====================================================
// 通用 Gemini JSON 请求
// =====================================================

async function askJSON(systemInstruction, prompt) {
  const ai = await getAI();

  const response = await generateWithRetry(ai, {
    contents: prompt,
    config: {
      responseMimeType: "application/json",
      systemInstruction
    }
  });

  return parseModelJson(response.text);
}

// =====================================================
// 健康检查与请求统计
// =====================================================

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    message: "AI短剧工厂视觉资产中心服务运行正常",
    model: MODEL,
    features: [
      "legacy-script",
      "legacy-storyboard",
      "legacy-asset-extraction",
      "legacy-image-prompts",
      "one-call-script-and-storyboard",
      "one-call-visual-assets-and-prompts",
      "response-cache",
      "no-retry-on-quota-error",
      "request-statistics"
    ]
  });
});

app.get("/api/request-stats", (req, res) => {
  res.json({
    ok: true,
    model: MODEL,
    ...requestStats,
    cacheEntries: responseCache.size,
    cacheTTLMinutes: CACHE_TTL / 60000
  });
});

// =====================================================
// 新接口一：一次请求生成剧本 + 人物 + 全部分镜
// POST /api/generate-episode
// =====================================================

app.post("/api/generate-episode", async (req, res) => {
  try {
    const story = cleanText(req.body?.story || req.body?.script, 18000);
    const duration = Number(
      req.body?.duration || req.body?.episodeDuration || 60
    );
    const clipDuration = Number(req.body?.clipDuration || 10);
    const genre = cleanText(req.body?.genre || "都市短剧", 100);

    if (!story) {
      return res.status(400).json({
        ok: false,
        error: "请先填写故事内容"
      });
    }

    if (![60, 90, 120].includes(duration)) {
      return res.status(400).json({
        ok: false,
        error: "单集时长只能选择60、90或120秒"
      });
    }

    if (![5, 10, 15].includes(clipDuration) ||
        duration % clipDuration !== 0) {
      return res.status(400).json({
        ok: false,
        error: "单段视频时长只能为5、10或15秒，并且必须能整除单集时长"
      });
    }

    const shotCount = duration / clipDuration;
    const bodyForCache = { story, duration, clipDuration, genre };

    return await runCachedJSON(
      "/api/generate-episode",
      bodyForCache,
      res,
      async () => {
        const systemInstruction = `
你是专业的中文真人AI短剧编剧、导演、分镜师和视觉连续性设计师。
请在一次输出中完成完整剧本、人物档案和全部分镜。
必须严格输出合法JSON，不要Markdown，不要解释。

创作要求：
1. 剧情完整、节奏紧凑、逻辑清楚；人物鲜明，对白自然。
2. 重要情节必须可视化，动作、表情、场景具体。
3. 连续剧本集要有冲突、反转和结尾悬念。
4. 不能凭空增加无关人物；同一人物只能建档一次。
5. 人物年龄感、性别、脸型、发型、体型和身份保持一致。
6. 分镜按剧情顺序排列，数量必须准确。
7. 每个镜头时长必须严格等于给定秒数，总时长必须准确。
8. 每镜头写清场景、出场人物、道具、画面、动作、对白、摄影机、声音和连续性。
9. videoPrompt必须是可独立使用的完整中文真人影视视频提示词。
10. imagePrompt必须是单一静态瞬间，不得写成连续动作。
11. 镜头提示词必须保持人物、服装、场景和道具一致。
12. 不明确的信息填写“未设定”，不要编造关键身份。

JSON结构：
{
 "title":"本集标题",
 "summary":"本集概述",
 "script":"完整剧本，包含场景、动作、对白和结尾悬念",
 "characters":[{
   "name":"姓名","age":"年龄","gender":"性别","height":"身高",
   "identity":"身份","mood":"性格气质","look":"脸型五官和外貌",
   "hair":"发型发色","clothes":"基础服装","props":"关联道具",
   "extra":"固定特征"
 }],
 "shots":[{
   "shotNumber":1,"duration":10,"shotTitle":"镜头标题",
   "sceneName":"场景名称","characters":["人物姓名"],"props":["道具名称"],
   "visual":"画面构图和内容","action":"动作表情",
   "dialogue":"对白","camera":"景别机位运镜",
   "audio":"声音设计","continuity":"连续性要求",
   "imagePrompt":"完整静态关键帧提示词",
   "videoPrompt":"完整中文视频提示词"
 }]
}
`;

        const prompt = `
题材：${genre}
单集时长：${duration}秒
每段视频时长：${clipDuration}秒
必须生成镜头数：${shotCount}个

用户故事/创作要求：
${story}

请先规划剧情节奏，再一次性输出完整剧本、人物档案和${shotCount}个镜头。
每个镜头必须为${clipDuration}秒。不得省略镜头，不得用“略”。
`;

        const parsed = await askJSON(systemInstruction, prompt);
        const script = cleanText(parsed.script, 90000);
        if (!script) throw new Error("AI没有生成有效剧本");

        const characters = normalizePeople(parsed.characters);
        const rawShots = Array.isArray(parsed.shots) ? parsed.shots : [];

        if (rawShots.length !== shotCount) {
          throw new Error(
            `AI返回${rawShots.length}个镜头，但要求${shotCount}个。为避免额外消耗请求，本次不会自动重复生成，请调整输入后再试。`
          );
        }

        const shots = rawShots.map((shot, index) => ({
          shotNumber: index + 1,
          duration: clipDuration,
          shotTitle: cleanText(shot.shotTitle, 200) || `镜头${index + 1}`,
          sceneName: cleanText(shot.sceneName, 200),
          characters: Array.isArray(shot.characters)
            ? shot.characters.map(x => cleanText(x, 80)).filter(Boolean)
            : [],
          props: Array.isArray(shot.props)
            ? shot.props.map(x => cleanText(x, 100)).filter(Boolean)
            : [],
          visual: cleanText(shot.visual, 3000),
          action: cleanText(shot.action, 3000),
          dialogue: cleanText(shot.dialogue, 2000),
          camera: cleanText(shot.camera, 2000),
          audio: cleanText(shot.audio, 1000),
          continuity: cleanText(shot.continuity, 2000),
          imagePrompt: cleanText(shot.imagePrompt, 8000),
          videoPrompt: cleanText(shot.videoPrompt, 6000),
          assetRefs: { characters: [], scenes: [], props: [] }
        }));

        if (shots.some(s => !s.videoPrompt)) {
          throw new Error("部分镜头缺少视频提示词，请检查输入后重新生成");
        }

        return {
          ok: true,
          title: cleanText(parsed.title, 200) || "AI短剧",
          summary: cleanText(parsed.summary, 3000),
          result: script,
          script,
          characters,
          characterCount: characters.length,
          duration,
          durationUnit: "seconds",
          episodeDuration: duration,
          clipDuration,
          shotCount,
          totalDuration: shots.reduce((sum, s) => sum + s.duration, 0),
          shots,
          model: MODEL,
          generationStages: 1
        };
      }
    );
  } catch (error) {
    return errorResponse(res, error);
  }
});

// =====================================================
// 新接口二：一次请求生成全剧资产 + 镜头提示词
// POST /api/visual-package
// =====================================================

app.post("/api/visual-package", async (req, res) => {
  try {
    const script = cleanText(req.body?.script, 90000);
    const genre = cleanText(req.body?.genre || "都市短剧", 100);
    const charactersIn = normalizePeople(req.body?.characters);
    const scenesIn = normalizeScenes(req.body?.scenes);
    const propsIn = normalizeProps(req.body?.props);
    const shots = normalizeShots(req.body?.shots);

    if (!script && !shots.length) {
      return res.status(400).json({
        ok: false,
        error: "请提供剧本或分镜资料"
      });
    }

    const bodyForCache = {
      script, genre,
      characters: charactersIn,
      scenes: scenesIn,
      props: propsIn,
      shots
    };

    return await runCachedJSON(
      "/api/visual-package",
      bodyForCache,
      res,
      async () => {
        const systemInstruction = `
你是专业影视美术指导、选角导演、场景设计师、道具设计师和Seedream提示词工程师。
本次必须在同一次输出中完成全剧视觉资产提取、镜头资产关联和所有镜头静态关键帧提示词。
只输出合法JSON，不要Markdown或解释。

核心原则：
1. 已有档案优先，不能改变已有角色脸型、五官、年龄感、体型、发型、身份和明确服装设定。
2. 同一人物、场景、道具只保留一份，不得重复创建；服装变化记入outfitVersions。
3. 提取所有有剧情作用的人物、实际出现的场景和重要道具，不必提取普通背景杂物。
4. 场景描述必须包含空间布局、门窗、家具、墙面、地面、光线、色彩和空间连续性。
5. 道具描述必须包含形状、材质、颜色、尺寸比例、用途和连续性。
6. 每个镜头必须关联实际出现的人物、场景和道具，名称必须与资产库名称一致。
7. 每个镜头生成一条独立完整的静态关键帧提示词，描述一个瞬间，不得写成视频动作过程。
8. 提示词用中文，具备真人影视摄影质感、真实皮肤与材质、明确构图、景别、机位、光线、色彩和主体位置。
9. 不得凭空增加人物或道具；没有明确信息写“未设定”。
10. 提示词不能使用“同上”“保持之前”等不完整表达。
11. 每条提示词必须能单独复制使用。
12. 控制输出规模：资产只列唯一资产；每个输入镜头最多一条keyframe提示词。

JSON格式：
{
 "title":"视觉资产方案名称",
 "summary":"资产概述",
 "characters":[{
   "name":"姓名","age":"年龄","gender":"性别","height":"身高",
   "identity":"身份","mood":"性格气质","look":"外貌",
   "hair":"发型","clothes":"基础服装","props":"关联道具",
   "extra":"固定特征",
   "outfitVersions":[{"name":"服装版本","description":"服装描述","usage":"使用场景"}]
 }],
 "scenes":[{
   "name":"场景名称","type":"场景类型","time":"时间",
   "desc":"完整场景描述","layout":"空间布局","lighting":"光线",
   "colors":"色彩","continuity":"连续性"
 }],
 "props":[{
   "name":"道具名称","type":"类别","description":"外观结构",
   "material":"材质","color":"颜色","size":"尺寸比例",
   "usage":"剧情用途","owner":"所属人物","continuity":"连续性"
 }],
 "keyMoments":[{
   "title":"关键画面","sceneName":"场景名称",
   "characters":["人物"],"props":["道具"],
   "description":"画面内容","emotion":"情绪","visualFocus":"视觉重点"
 }],
 "shotLinks":[{
   "shotNumber":1,"characters":["人物资产名称"],
   "scenes":["场景资产名称"],"props":["道具资产名称"]
 }],
 "prompts":[{
   "id":"编号","category":"keyframe","assetType":"keyframe",
   "assetName":"镜头/资产名称","view":"静态关键帧",
   "shotNumber":1,"title":"提示词标题","subject":"主体",
   "purpose":"用途","prompt":"完整中文Seedream提示词",
   "referenceGuide":"应上传的人物、场景和道具参考图",
   "consistency":"一致性检查重点",
   "negativePrompt":"负面约束词","aspectRatio":"16:9",
   "assetRefs":{"characters":[],"scenes":[],"props":[]}
 }]
}
`;

        const prompt = `
题材：${genre}

完整剧本：
${script || "未提供完整剧本，依据分镜和现有档案提取。"}

已有演员档案（优先保留，不要重复）：
${JSON.stringify(charactersIn)}

已有场景档案：
${JSON.stringify(scenesIn)}

已有道具档案：
${JSON.stringify(propsIn)}

全部分镜（请逐镜头关联资产并生成关键帧提示词）：
${JSON.stringify(shots)}

请一次性完成：
A. 提取并去重全剧人物、场景、道具。
B. 提取重要关键剧情画面。
C. 为每个镜头建立shotLinks，关联真实出现的资产。
D. 为每个镜头生成一条独立、完整的静态关键帧Seedream提示词。
E. 每条提示词的assetRefs必须与shotLinks及资产名称一致。
F. 不要为同一资产重复建档；已有档案的关键设定不得覆盖。
`;

        const parsed = await askJSON(systemInstruction, prompt);

        const characters = normalizePeople(parsed.characters);
        const scenes = normalizeScenes(parsed.scenes);
        const props = normalizeProps(parsed.props);
        const keyMoments = normalizeKeyMoments(parsed.keyMoments);
        const prompts = normalizePrompts(parsed.prompts);

        const shotLinks = Array.isArray(parsed.shotLinks)
          ? parsed.shotLinks.slice(0, 60).map(link => ({
              shotNumber: Number(link.shotNumber) || 0,
              characters: Array.isArray(link.characters)
                ? link.characters.map(x => cleanText(x, 100)).filter(Boolean)
                : [],
              scenes: Array.isArray(link.scenes)
                ? link.scenes.map(x => cleanText(x, 100)).filter(Boolean)
                : [],
              props: Array.isArray(link.props)
                ? link.props.map(x => cleanText(x, 100)).filter(Boolean)
                : []
            }))
          : [];

        if (!characters.length && !scenes.length &&
            !props.length && !prompts.length) {
          throw new Error("AI没有返回有效视觉资产或镜头提示词");
        }

        return {
          ok: true,
          title: cleanText(parsed.title, 200) || "全剧视觉资产与提示词",
          summary: cleanText(parsed.summary, 3000),
          characters,
          scenes,
          props,
          keyMoments,
          shotLinks,
          prompts,
          promptCount: prompts.length,
          counts: {
            characters: characters.length,
            scenes: scenes.length,
            props: props.length,
            keyMoments: keyMoments.length,
            prompts: prompts.length
          },
          model: MODEL,
          generationStages: 1
        };
      }
    );
  } catch (error) {
    return errorResponse(res, error);
  }
});

// =====================================================
// 旧接口一：剧本生成（保留兼容）
// POST /api/generate
// =====================================================

app.post("/api/generate", async (req, res) => {
  try {
    const story = cleanText(req.body?.story, 10000);
    const duration = Number(req.body?.duration || 60);
    const genre = cleanText(req.body?.genre || "都市短剧", 100);

    if (!story) {
      return res.status(400).json({ ok: false, error: "请先填写故事内容" });
    }
    if (![60, 90, 120].includes(duration)) {
      return res.status(400).json({
        ok: false,
        error: "单集时长只能选择60、90或120秒"
      });
    }

    const body = { story, duration, genre };

    return await runCachedJSON("/api/generate", body, res, async () => {
      const parsed = await askJSON(`
你是专业中文真人短剧编剧。剧情完整、节奏紧凑、人物鲜明、对白自然；
符合指定时长；连续剧要有冲突反转和结尾悬念；提取重要人物且不重复。
只输出合法JSON：
{"script":"完整剧本","characters":[{"name":"","age":"","gender":"","height":"","identity":"","mood":"","look":"","hair":"","clothes":"","props":"","extra":""}]}
`, `
故事内容：
${story}
单集时长：${duration}秒
题材：${genre}
请生成完整剧本，包含具体场景、动作、对白和结尾悬念，并提取全部重要人物。
`);
      const script = cleanText(parsed.script, 90000);
      if (!script) throw new Error("AI没有生成有效剧本");

      const characters = normalizePeople(parsed.characters);
      return {
        ok: true,
        result: script,
        characters,
        characterCount: characters.length,
        duration,
        durationUnit: "seconds",
        model: MODEL
      };
    });
  } catch (error) {
    return errorResponse(res, error);
  }
});

// =====================================================
// 旧接口二：单独分镜（保留兼容）
// POST /api/storyboard
// =====================================================

app.post("/api/storyboard", async (req, res) => {
  try {
    const script = cleanText(req.body?.script, 90000);
    const episodeDuration = Number(req.body?.episodeDuration);
    const clipDuration = Number(req.body?.clipDuration);
    const genre = cleanText(req.body?.genre || "都市短剧", 100);

    if (!script) {
      return res.status(400).json({ ok: false, error: "请先生成或填写剧本" });
    }
    if (![60, 90, 120].includes(episodeDuration)) {
      return res.status(400).json({ ok: false, error: "单集时长必须为60、90或120秒" });
    }
    if (![5, 10, 15].includes(clipDuration) ||
        episodeDuration % clipDuration !== 0) {
      return res.status(400).json({
        ok: false,
        error: "单段时长只能为5、10或15秒，且必须能整除单集时长"
      });
    }

    const shotCount = episodeDuration / clipDuration;
    const characters = normalizePeople(req.body?.characters).slice(0, 30);
    const scenes = normalizeScenes(req.body?.scenes).slice(0, 30);
    const props = normalizeProps(req.body?.props).slice(0, 40);
    const body = { script, episodeDuration, clipDuration, genre, characters, scenes, props };

    return await runCachedJSON("/api/storyboard", body, res, async () => {
      const parsed = await askJSON(`
你是专业真人短剧导演和AI分镜师。严格按剧情顺序拆成指定数量镜头，
每个镜头时长准确；保持人物、服装、发型、道具和场景连续一致。
videoPrompt必须完整独立；imagePrompt必须是单一静态瞬间。
只输出合法JSON：
{"title":"","summary":"","shots":[{"shotNumber":1,"duration":10,"shotTitle":"","sceneName":"","characters":[],"props":[],"visual":"","action":"","dialogue":"","camera":"","audio":"","continuity":"","imagePrompt":"","videoPrompt":""}]}
`, `
题材：${genre}
总时长：${episodeDuration}秒
每段时长：${clipDuration}秒
镜头数量：${shotCount}个
剧本：
${script}
人物档案：${JSON.stringify(characters)}
场景档案：${JSON.stringify(scenes)}
道具档案：${JSON.stringify(props)}
请严格生成${shotCount}个镜头，每个${clipDuration}秒，总计${episodeDuration}秒。
`);
      const rawShots = Array.isArray(parsed.shots) ? parsed.shots : [];
      if (rawShots.length !== shotCount) {
        throw new Error(`AI返回${rawShots.length}个镜头，要求${shotCount}个`);
      }

      const shots = rawShots.map((shot, index) => ({
        shotNumber: index + 1,
        duration: clipDuration,
        shotTitle: cleanText(shot.shotTitle, 200) || `镜头${index + 1}`,
        sceneName: cleanText(shot.sceneName, 200),
        characters: Array.isArray(shot.characters)
          ? shot.characters.map(x => cleanText(x, 80)).filter(Boolean) : [],
        props: Array.isArray(shot.props)
          ? shot.props.map(x => cleanText(x, 100)).filter(Boolean) : [],
        visual: cleanText(shot.visual, 3000),
        action: cleanText(shot.action, 3000),
        dialogue: cleanText(shot.dialogue, 2000),
        camera: cleanText(shot.camera, 2000),
        audio: cleanText(shot.audio, 1000),
        continuity: cleanText(shot.continuity, 2000),
        imagePrompt: cleanText(shot.imagePrompt, 8000),
        videoPrompt: cleanText(shot.videoPrompt, 6000),
        assetRefs: { characters: [], scenes: [], props: [] }
      }));

      if (shots.some(s => !s.videoPrompt)) {
        throw new Error("部分镜头缺少视频提示词");
      }

      return {
        ok: true,
        title: cleanText(parsed.title, 200) || "AI短剧分镜",
        summary: cleanText(parsed.summary, 3000),
        episodeDuration,
        clipDuration,
        shotCount,
        totalDuration: shots.reduce((sum, s) => sum + s.duration, 0),
        shots,
        model: MODEL
      };
    });
  } catch (error) {
    return errorResponse(res, error);
  }
});

// =====================================================
// 旧接口三：视觉资产提取（保留兼容）
// POST /api/extract-assets
// =====================================================

app.post("/api/extract-assets", async (req, res) => {
  try {
    const script = cleanText(req.body?.script, 90000);
    const genre = cleanText(req.body?.genre || "都市短剧", 100);
    const existingCharacters = normalizePeople(req.body?.characters);
    const existingScenes = normalizeScenes(req.body?.scenes);
    const existingProps = normalizeProps(req.body?.props);

    if (!script) {
      return res.status(400).json({ ok: false, error: "请先提供剧本内容" });
    }

    const body = {
      script, genre,
      characters: existingCharacters,
      scenes: existingScenes,
      props: existingProps
    };

    return await runCachedJSON("/api/extract-assets", body, res, async () => {
      const parsed = await askJSON(`
你是专业影视美术指导、选角导演、场景设计师和道具设计师。
提取全剧唯一人物、场景、重要道具和关键剧情画面。已有档案优先保留，
同一资产不得重复；人物服装变化记入outfitVersions。未知填写“未设定”。
只输出合法JSON：
{"title":"","summary":"","characters":[{"name":"","age":"","gender":"","height":"","identity":"","mood":"","look":"","hair":"","clothes":"","props":"","extra":"","outfitVersions":[]}],"scenes":[{"name":"","type":"","time":"","desc":"","layout":"","lighting":"","colors":"","continuity":""}],"props":[{"name":"","type":"","description":"","material":"","color":"","size":"","usage":"","owner":"","continuity":""}],"keyMoments":[{"title":"","sceneName":"","characters":[],"props":[],"description":"","emotion":"","visualFocus":""}]}
`, `
题材：${genre}
完整剧本：
${script}
已有演员：
${JSON.stringify(existingCharacters)}
已有场景：
${JSON.stringify(existingScenes)}
已有道具：
${JSON.stringify(existingProps)}
请提取并去重所有视觉资产和关键剧情画面，不得擅自改变已有档案的关键设定。
`);
      const characters = normalizePeople(parsed.characters);
      const scenes = normalizeScenes(parsed.scenes);
      const props = normalizeProps(parsed.props);
      const keyMoments = normalizeKeyMoments(parsed.keyMoments);

      return {
        ok: true,
        title: cleanText(parsed.title, 200) || "视觉资产提取结果",
        summary: cleanText(parsed.summary, 3000),
        characters, scenes, props, keyMoments,
        counts: {
          characters: characters.length,
          scenes: scenes.length,
          props: props.length,
          keyMoments: keyMoments.length
        },
        model: MODEL
      };
    });
  } catch (error) {
    return errorResponse(res, error);
  }
});

// =====================================================
// 旧接口四：Seedream提示词（保留兼容）
// POST /api/image-prompts
// =====================================================

app.post("/api/image-prompts", async (req, res) => {
  try {
    const script = cleanText(req.body?.script, 90000);
    const genre = cleanText(req.body?.genre || "都市短剧", 100);
    const category = cleanText(req.body?.category || "all", 40);
    const allowed = [
      "all", "character", "character_view", "scene", "scene_view",
      "prop", "prop_view", "keyframe", "storyboard", "asset_all"
    ];

    if (!allowed.includes(category)) {
      return res.status(400).json({ ok: false, error: "不支持的生图提示词类型" });
    }

    const characters = normalizePeople(req.body?.characters);
    const scenes = normalizeScenes(req.body?.scenes);
    const props = normalizeProps(req.body?.props);
    const shots = normalizeShots(req.body?.shots);
    const view = cleanText(req.body?.view || "", 100);
    const targetName = cleanText(req.body?.targetName || "", 100);

    if (!script && !characters.length && !scenes.length &&
        !props.length && !shots.length) {
      return res.status(400).json({
        ok: false,
        error: "请先提供剧本、人物、场景、道具或分镜资料"
      });
    }

    const body = {
      script, genre, category, characters, scenes, props, shots, view, targetName
    };

    return await runCachedJSON("/api/image-prompts", body, res, async () => {
      const parsed = await askJSON(`
你是专业电影美术指导、真人角色/场景/道具设计师和Seedream中文提示词工程师。
生成可直接复制的完整中文图片提示词。真人影视摄影质感，真实皮肤和材质，
明确主体、构图、景别、机位、光线、色彩。保持人物、场景、道具连续一致。
静态关键帧只能描述一个瞬间。提示词不得使用“同上”等省略表达。
每条提示词需给出参考图说明、一致性检查和负面约束。
只输出合法JSON：
{"title":"","summary":"","prompts":[{"id":"","category":"keyframe","assetType":"keyframe","assetName":"","view":"","shotNumber":1,"title":"","subject":"","purpose":"","prompt":"","referenceGuide":"","consistency":"","negativePrompt":"","aspectRatio":"16:9","assetRefs":{"characters":[],"scenes":[],"props":[]}}]}
`, `
题材：${genre}
类别：${category}
指定视角：${view || "按类别决定"}
指定资产：${targetName || "全部"}
剧本：
${script || "未提供"}
人物：
${JSON.stringify(characters)}
场景：
${JSON.stringify(scenes)}
道具：
${JSON.stringify(props)}
分镜：
${JSON.stringify(shots)}
请根据类别生成完整提示词。若有分镜，每个镜头生成独立静态关键帧提示词，并关联对应资产。
`);
      const prompts = normalizePrompts(parsed.prompts);
      if (!prompts.length) throw new Error("AI没有生成有效的生图提示词");

      return {
        ok: true,
        title: cleanText(parsed.title, 200) || "视觉资产生图提示词",
        summary: cleanText(parsed.summary, 3000),
        promptCount: prompts.length,
        prompts,
        model: MODEL
      };
    });
  } catch (error) {
    return errorResponse(res, error);
  }
});

// =====================================================
// 启动服务
// =====================================================

app.listen(PORT, () => {
  console.log(`AI短剧工厂视觉资产中心已启动，端口：${PORT}`);
  console.log(`当前 Gemini 模型：${MODEL}`);
  console.log("新增批量接口：POST /api/generate-episode");
  console.log("新增批量接口：POST /api/visual-package");
  console.log("429额度错误：不自动重试");
});
