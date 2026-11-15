
const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.join(__dirname, "public")));

const MODEL = process.env.GEMINI_MODEL || "gemini-3.8-flash";
let aiClient = null;

// =====================================
// Gemini 初始化
// =====================================

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

// =====================================
// 基础工具
// =====================================

function cleanText(value, maxLength = 5000) {
  return String(value ?? "")
    .replace(/\u0000/g, "")
    .trim()
    .slice(0, maxLength);
}

function parseModelJson(text) {
  if (!text) {
    throw new Error("AI 没有返回内容");
  }

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

function isTemporaryError(error) {
  const message = String(
    error?.message || error || ""
  ).toLowerCase();

  return [
    "503",
    "unavailable",
    "high demand",
    "429",
    "resource_exhausted",
    "500",
    "internal server error",
    "502",
    "504"
  ].some(x => message.includes(x));
}

async function generateWithRetry(ai, request) {
  const maxAttempts = 3;
  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      console.log(
        `Gemini 请求：第 ${attempt}/${maxAttempts} 次，模型：${MODEL}`
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

      console.error(
        `Gemini 第 ${attempt} 次请求失败：`,
        error?.message || error
      );

      if (
        !isTemporaryError(error) ||
        attempt === maxAttempts
      ) {
        throw error;
      }

      const waitTime = attempt * 2000;

      console.log(`${waitTime / 1000} 秒后自动重试……`);

      await new Promise(resolve =>
        setTimeout(resolve, waitTime)
      );
    }
  }

  throw lastError || new Error("Gemini 请求失败");
}

function errorResponse(res, error) {
  console.error("AI请求失败：", error);

  const message = String(error?.message || "未知错误");
  const temporary = isTemporaryError(error);

  return res.status(temporary ? 503 : 500).json({
    ok: false,
    error: temporary
      ? "Gemini 服务暂时繁忙，系统已经自动重试，请稍后再试。"
      : message,
    detail: message,
    model: MODEL
  });
}

// =====================================
// 数据标准化
// =====================================

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
    extra: cleanText(c.extra, 500)
  };
}

function normalizePeople(list) {
  if (!Array.isArray(list)) return [];

  return list
    .slice(0, 40)
    .map(c => normalizeCharacter(c));
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
  }));
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
  }));
}

function normalizeShots(list) {
  if (!Array.isArray(list)) return [];

  return list.slice(0, 50).map((s, index) => ({
    shotNumber: Number(s.shotNumber) || index + 1,
    duration: Number(s.duration) || 0,
    shotTitle: cleanText(s.shotTitle, 200),
    sceneName: cleanText(s.sceneName, 200),

    characters: Array.isArray(s.characters)
      ? s.characters
          .map(x => cleanText(x, 80))
          .filter(Boolean)
      : [],

    props: Array.isArray(s.props)
      ? s.props
          .map(x => cleanText(
            typeof x === "string" ? x : x.name,
            100
          ))
          .filter(Boolean)
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

// =====================================
// 健康检查
// =====================================

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    message: "AI短剧工厂视觉资产中心服务运行正常",
    model: MODEL,

    features: [
      "script",
      "storyboard",
      "seedream-image-prompts",
      "visual-asset-extraction",
      "character-multi-view",
      "scene-multi-view",
      "prop-multi-view",
      "shot-keyframe-prompts",
      "asset-consistency"
    ]
  });
});

// =====================================
// 第一阶段：剧本生成
// 保留原有接口
// =====================================

app.post("/api/generate", async (req, res) => {
  try {
    const story = cleanText(req.body?.story, 10000);
    const duration = Number(req.body?.duration || 60);
    const genre = cleanText(
      req.body?.genre || "都市短剧",
      100
    );

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

    const ai = await getAI();

    const systemInstruction = `
你是一名专业的AI真人短剧编剧、导演和人物设定设计师。

请创作适合真人AI视频制作的中文短剧。

要求：
1. 剧情完整，逻辑清晰，节奏紧凑。
2. 人物性格鲜明，对白自然。
3. 动作、表情、场景和视觉表现具体。
4. 必须严格控制在用户指定的秒数范围内。
5. 重要情节要有视觉表现。
6. 如果是连续剧，本集必须有冲突、反转和结尾悬念。
7. 提取所有有实际剧情作用的人物。
8. 同一个人物不能重复创建。
9. 人物外貌、年龄、性别和身份必须保持一致。
10. 没有明确的信息填写“未设定”，不要编造关键身份。

只能输出合法JSON，不要输出Markdown或解释。

格式：
{
  "script": "完整剧本",
  "characters": [
    {
      "name": "姓名",
      "age": "年龄",
      "gender": "性别",
      "height": "身高",
      "identity": "身份",
      "mood": "性格气质",
      "look": "外貌",
      "hair": "发型",
      "clothes": "服装",
      "props": "道具",
      "extra": "其他特征"
    }
  ]
}

characters必须是数组。
`;

    const prompt = `
【故事内容】
${story}

【单集总时长】
${duration}秒

【题材】
${genre}

请生成完整剧本，并提取全部重要人物资料。
剧本需要包含具体场景、人物动作、对白、镜头建议和结尾悬念。
`;

    const response = await generateWithRetry(ai, {
      contents: prompt,
      config: {
        responseMimeType: "application/json",
        systemInstruction
      }
    });

    const parsed = parseModelJson(response.text);
    const script = cleanText(parsed.script, 90000);

    if (!script) {
      throw new Error("AI没有生成有效剧本内容");
    }

    const characters = (
      Array.isArray(parsed.characters)
        ? parsed.characters
        : []
    )
      .filter(c => c && cleanText(c.name, 80))
      .map(normalizeCharacter);

    return res.json({
      ok: true,
      result: script,
      characters,
      characterCount: characters.length,
      duration,
      durationUnit: "seconds",
      model: MODEL
    });

  } catch (error) {
    return errorResponse(res, error);
  }
});

// =====================================
// 第二阶段：自动分镜
// 保留原有接口，增加道具和参考图字段
// =====================================

app.post("/api/storyboard", async (req, res) => {
  try {
    const script = cleanText(req.body?.script, 90000);
    const episodeDuration = Number(req.body?.episodeDuration);
    const clipDuration = Number(req.body?.clipDuration);

    const genre = cleanText(
      req.body?.genre || "都市短剧",
      100
    );

    if (!script) {
      return res.status(400).json({
        ok: false,
        error: "请先生成或填写剧本"
      });
    }

    if (![60, 90, 120].includes(episodeDuration)) {
      return res.status(400).json({
        ok: false,
        error: "单集时长必须为60、90或120秒"
      });
    }

    if (![5, 10, 15].includes(clipDuration)) {
      return res.status(400).json({
        ok: false,
        error: "单段视频时长必须为5、10或15秒"
      });
    }

    if (episodeDuration % clipDuration !== 0) {
      return res.status(400).json({
        ok: false,
        error: "单集时长必须能被单段时长整除"
      });
    }

    const shotCount = episodeDuration / clipDuration;

    const characters = normalizePeople(
      req.body?.characters
    ).slice(0, 30);

    const scenes = normalizeScenes(
      req.body?.scenes
    ).slice(0, 30);

    const props = normalizeProps(
      req.body?.props
    ).slice(0, 40);

    const ai = await getAI();

    const systemInstruction = `
你是一名专业的真人短剧导演、分镜师和AI视频提示词工程师。

任务：将完整剧本拆成精确数量的独立视频镜头。

必须遵守：
1. 必须返回指定数量的镜头。
2. 每个镜头时长严格等于指定时长。
3. 镜头按剧情顺序排列。
4. 人物、服装、发型、道具和场景保持连续一致。
5. 不得擅自改变人物身份、外貌或服装。
6. 每个镜头都能独立用于AI视频生成。
7. 对白要适合镜头时长。
8. 不得凭空增加重要人物。
9. 优先使用用户提供的人物档案、场景档案和道具档案。
10. 视频提示词必须描述主体、人物外观、动作、表情、环境、运镜、光线和画面风格。
11. 强调真人影视写实风格、人物连续性和自然动作。
12. 每个镜头应有明确开场状态和结束状态。
13. 每个镜头必须列出实际出现的人物。
14. 每个镜头必须列出实际出现的重要道具。
15. 每个镜头必须明确对应场景。
16. imagePrompt是静态图片提示词，不是视频提示词。
17. imagePrompt必须描述一个具体瞬间的构图、人物位置和动作状态。
18. 不得将静态图片提示词写成连续动作过程。

只能输出合法JSON。

格式：
{
  "title": "本集名称",
  "summary": "本集分镜概述",
  "shots": [
    {
      "shotNumber": 1,
      "duration": 10,
      "shotTitle": "镜头标题",
      "sceneName": "场景名称",
      "characters": ["人物姓名"],
      "props": ["道具名称"],
      "visual": "画面内容和构图",
      "action": "人物动作和表情",
      "dialogue": "对白",
      "camera": "景别、机位和运镜方式",
      "audio": "声音设计",
      "continuity": "连续性要求",
      "imagePrompt": "完整静态关键帧提示词",
      "videoPrompt": "完整中文视频提示词"
    }
  ]
}
`;

    const prompt = `
【题材】
${genre}

【整集总时长】
${episodeDuration}秒

【每段视频时长】
${clipDuration}秒

【必须生成的镜头数量】
${shotCount}个

【剧本】
${script}

【现有人物档案】
${JSON.stringify(characters, null, 2)}

【现有场景档案】
${JSON.stringify(scenes, null, 2)}

【现有道具档案】
${JSON.stringify(props, null, 2)}

请严格按照剧情顺序拆分镜头。

计算要求：
- 镜头数量必须是${shotCount}个。
- 每个镜头必须是${clipDuration}秒。
- 总时长必须正好为${episodeDuration}秒。
- 每个镜头的videoPrompt必须完整。
- 每个镜头的imagePrompt必须完整。
- 同一人物必须保持同一张脸、发型、体型和服装。
- 同一场景必须保持空间结构和家具位置一致。
- 同一道具必须保持外观、材质和颜色一致。
`;

    const response = await generateWithRetry(ai, {
      contents: prompt,
      config: {
        responseMimeType: "application/json",
        systemInstruction
      }
    });

    const parsed = parseModelJson(response.text);

    const rawShots = Array.isArray(parsed.shots)
      ? parsed.shots
      : [];

    if (rawShots.length !== shotCount) {
      throw new Error(
        `AI返回了${rawShots.length}个镜头，但本次要求${shotCount}个。请重新生成。`
      );
    }

    const shots = rawShots.map((shot, index) => ({
      shotNumber: index + 1,
      duration: clipDuration,

      shotTitle: cleanText(
        shot.shotTitle,
        200
      ) || `镜头${index + 1}`,

      sceneName: cleanText(
        shot.sceneName,
        200
      ),

      characters: Array.isArray(shot.characters)
        ? shot.characters
            .map(x => cleanText(x, 80))
            .filter(Boolean)
        : [],

      props: Array.isArray(shot.props)
        ? shot.props
            .map(x => cleanText(x, 100))
            .filter(Boolean)
        : [],

      visual: cleanText(shot.visual, 3000),
      action: cleanText(shot.action, 3000),
      dialogue: cleanText(shot.dialogue, 2000),
      camera: cleanText(shot.camera, 2000),
      audio: cleanText(shot.audio, 1000),
      continuity: cleanText(shot.continuity, 2000),

      imagePrompt: cleanText(
        shot.imagePrompt,
        8000
      ),

      videoPrompt: cleanText(
        shot.videoPrompt,
        6000
      ),

      assetRefs: {
        characters: [],
        scenes: [],
        props: []
      }
    }));

    if (shots.some(s => !s.videoPrompt)) {
      throw new Error("部分镜头缺少视频提示词，请重新生成");
    }

    return res.json({
      ok: true,

      title: cleanText(
        parsed.title,
        200
      ) || "AI短剧分镜",

      summary: cleanText(
        parsed.summary,
        3000
      ),

      episodeDuration,
      clipDuration,
      shotCount,

      totalDuration: shots.reduce(
        (sum, s) => sum + s.duration,
        0
      ),

      shots,
      model: MODEL
    });

  } catch (error) {
    return errorResponse(res, error);
  }
});

// =====================================
// 第三阶段：剧本视觉资产提取
// 新增接口
// =====================================

app.post("/api/extract-assets", async (req, res) => {
  try {
    const script = cleanText(req.body?.script, 90000);

    const genre = cleanText(
      req.body?.genre || "都市短剧",
      100
    );

    const existingCharacters = normalizePeople(
      req.body?.characters
    );

    const existingScenes = normalizeScenes(
      req.body?.scenes
    );

    const existingProps = normalizeProps(
      req.body?.props
    );

    if (!script) {
      return res.status(400).json({
        ok: false,
        error: "请先提供剧本内容"
      });
    }

    const ai = await getAI();

    const systemInstruction = `
你是一名专业的影视美术指导、选角导演、场景设计师和道具设计师。

你的任务是从剧本中提取完整的视觉资产清单。

需要提取四大类：

一、人物资产 characters
提取所有有实际剧情作用的人物。
同一人物只能出现一次。
人物资料必须具体、稳定、可用于真人AI演员定妆。
不能把同一个人物的不同服装版本误判成不同人物。
服装变化应记录在 outfitVersions 中。

二、场景资产 scenes
提取所有实际发生剧情的独立空间。
同一地点在不同时间或灯光状态下仍属于同一场景。
空间布局必须能够被反复还原。
记录门窗、家具、墙面、地面、主要陈设和空间关系。

三、道具资产 props
提取有剧情作用、需要保持外观一致的重要道具。
例如手机、合同、戒指、车辆、文件、礼物、首饰等。
普通背景物品不需要全部提取。
同一件道具不能重复创建。

四、关键剧情画面 keyMoments
提取重要冲突、打脸、反转、身份揭露、情绪爆发和悬念瞬间。
每个关键画面必须有具体人物、场景、动作和画面重点。

已有档案优先保留。
如果新提取结果与已有档案相同，不要创建重复资产。
不能擅自改变已有角色的脸型、年龄感、体型、发型和身份。
没有明确的信息填写“未设定”。

只能输出合法JSON，不要输出Markdown。

格式：
{
  "title": "资产提取方案名称",
  "summary": "资产提取概述",
  "characters": [
    {
      "name": "人物姓名",
      "age": "年龄",
      "gender": "性别",
      "height": "身高",
      "identity": "身份",
      "mood": "性格气质",
      "look": "脸型五官和外貌",
      "hair": "发型发色",
      "clothes": "基础服装",
      "props": "关联道具",
      "extra": "其他固定特征",
      "outfitVersions": [
        {
          "name": "服装版本名称",
          "description": "服装描述",
          "usage": "使用场景"
        }
      ]
    }
  ],
  "scenes": [
    {
      "name": "场景名称",
      "type": "场景类型",
      "time": "时间",
      "desc": "完整场景描述",
      "layout": "空间布局",
      "lighting": "光线设计",
      "colors": "主要色彩",
      "continuity": "空间连续性要求"
    }
  ],
  "props": [
    {
      "name": "道具名称",
      "type": "道具类别",
      "description": "外观结构",
      "material": "材质",
      "color": "颜色",
      "size": "尺寸比例",
      "usage": "剧情用途",
      "owner": "所属人物",
      "continuity": "外观连续性要求"
    }
  ],
  "keyMoments": [
    {
      "title": "画面名称",
      "sceneName": "对应场景",
      "characters": ["人物姓名"],
      "props": ["道具名称"],
      "description": "画面内容",
      "emotion": "情绪重点",
      "visualFocus": "视觉重点"
    }
  ]
}
`;

    const prompt = `
【题材】
${genre}

【完整剧本】
${script}

【已有的人物档案】
${JSON.stringify(existingCharacters, null, 2)}

【已有的场景档案】
${JSON.stringify(existingScenes, null, 2)}

【已有的道具档案】
${JSON.stringify(existingProps, null, 2)}

请提取全部视觉资产。

要求：
1. 已有资产不要重复创建。
2. 已有角色资料不得随意改变。
3. 人物服装变化单独列为服装版本。
4. 场景必须能够通过多视角图片还原。
5. 道具必须具有可识别、可复现的外观特征。
6. 关键剧情画面必须来自真实剧情。
7. 所有名称尽量简短、稳定，方便后续镜头关联。
`;

    const response = await generateWithRetry(ai, {
      contents: prompt,
      config: {
        responseMimeType: "application/json",
        systemInstruction
      }
    });

    const parsed = parseModelJson(response.text);

    const characters = normalizePeople(
      parsed.characters
    );

    const scenes = normalizeScenes(
      parsed.scenes
    );

    const props = normalizeProps(
      parsed.props
    );

    const keyMoments = Array.isArray(parsed.keyMoments)
      ? parsed.keyMoments.slice(0, 60).map((item, index) => ({
          id: cleanText(item.id, 100) || `moment-${index + 1}`,
          title: cleanText(item.title, 200),
          sceneName: cleanText(item.sceneName, 100),

          characters: Array.isArray(item.characters)
            ? item.characters
                .map(x => cleanText(x, 80))
                .filter(Boolean)
            : [],

          props: Array.isArray(item.props)
            ? item.props
                .map(x => cleanText(x, 100))
                .filter(Boolean)
            : [],

          description: cleanText(
            item.description,
            2000
          ),

          emotion: cleanText(
            item.emotion,
            500
          ),

          visualFocus: cleanText(
            item.visualFocus,
            1000
          )
        }))
      : [];

    return res.json({
      ok: true,

      title: cleanText(
        parsed.title,
        200
      ) || "视觉资产提取结果",

      summary: cleanText(
        parsed.summary,
        3000
      ),

      characters,
      scenes,
      props,
      keyMoments,

      counts: {
        characters: characters.length,
        scenes: scenes.length,
        props: props.length,
        keyMoments: keyMoments.length
      },

      model: MODEL
    });

  } catch (error) {
    return errorResponse(res, error);
  }
});

// =====================================
// 第四阶段：Seedream视觉资产提示词中心
// 扩展多视图和镜头静态参考图
// =====================================

app.post("/api/image-prompts", async (req, res) => {
  try {
    const script = cleanText(
      req.body?.script,
      90000
    );

    const genre = cleanText(
      req.body?.genre || "都市短剧",
      100
    );

    const category = cleanText(
      req.body?.category || "all",
      40
    );

    const allowedCategories = [
      "all",
      "character",
      "character_view",
      "scene",
      "scene_view",
      "prop",
      "prop_view",
      "keyframe",
      "storyboard",
      "asset_all"
    ];

    if (!allowedCategories.includes(category)) {
      return res.status(400).json({
        ok: false,
        error: "不支持的生图提示词类型"
      });
    }

    const characters = normalizePeople(
      req.body?.characters
    );

    const scenes = normalizeScenes(
      req.body?.scenes
    );

    const props = normalizeProps(
      req.body?.props
    );

    const shots = normalizeShots(
      req.body?.shots
    );

    const viewName = cleanText(
      req.body?.view || "",
      100
    );

    const targetName = cleanText(
      req.body?.targetName || "",
      100
    );

    if (
      !script &&
      characters.length === 0 &&
      scenes.length === 0 &&
      props.length === 0 &&
      shots.length === 0
    ) {
      return res.status(400).json({
        ok: false,
        error: "请先提供剧本、人物、场景、道具或分镜资料"
      });
    }

    const ai = await getAI();

    const systemInstruction = `
你是一名专业的电影美术指导、真人影视角色设计师、
场景概念设计师、道具设计师，以及豆包 Seedream 中文提示词工程师。

你的任务是生成可以直接复制到图片生成工具使用的高质量中文提示词。

【整体视觉标准】
1. 真人影视摄影质感，不是动漫、插画或游戏建模。
2. 真实皮肤纹理、自然五官比例、真实材质。
3. 主体明确，构图清楚，细节丰富。
4. 具体描述景别、机位、光线、色彩、环境和视觉重点。
5. 使用完整自然中文，不要只堆砌关键词。
6. 不要出现乱码、随机文字、字幕、水印或Logo。
7. 不要虚构已有档案中明确的人物身份和外貌。
8. 同一人物必须保持相同脸型、五官、肤色、年龄感、体型和发型。
9. 已有服装设定时不能擅自换装。
10. 同一场景必须保持空间布局、家具位置和光线方向一致。
11. 同一道具必须保持颜色、结构、材质和形状一致。
12. 不同视角必须表现同一个资产，不能生成相似但不同的对象。

【人物多视图】
人物视图应按实际需要生成：
- 正面全身
- 左前45度
- 右前45度
- 左侧面
- 右侧面
- 背面全身
- 面部近景
- 表情参考
- 服装版本参考

每张图只展示同一个人物。
如果生成角色设定板，可以在同一张图中安排多个视角，但必须确保每个视角是同一演员。
人物脸部必须清晰，不得出现多张不同的脸。
如果是单视图任务，画面只生成指定视角，不得擅自加入其他角度。

【场景多视图】
场景视图应按需要生成：
- 主视角全景
- 反方向全景
- 左侧视角
- 右侧视角
- 空间布局参考
- 重要区域特写
- 白天状态
- 夜晚状态

同一场景的门窗、家具、墙面、地面和空间比例必须一致。
场景参考图优先不出现人物。

【道具多视图】
道具视图应按需要生成：
- 正面
- 背面
- 左侧
- 右侧
- 结构细节
- 材质特写
- 使用状态
- 开启或展开状态

每张图只展示同一件道具。
材质、颜色、形状、尺寸比例必须一致。
不能把道具变成不同型号或不同款式。

【镜头静态参考图】
每个镜头生成独立静态关键帧。
必须明确：
- 镜头编号
- 对应场景
- 出场人物
- 人物在画面中的位置
- 人物动作和表情
- 重要道具的位置和状态
- 景别和机位
- 构图和光线
- 画面色调
- 与前后镜头的连续性

静态参考图只描述一个瞬间，不得写成连续视频动作。

【资产关联】
提示词应尽可能关联现有人物、场景、道具名称。
如果是镜头参考图，必须在assetRefs中列出对应资产。
不得凭空创建已有档案之外的角色或道具。

【提示词质量】
每条prompt都必须完整、独立、可直接复制。
referenceGuide说明需要上传哪些参考图。
consistency说明生成后需要重点检查什么。
negativePrompt描述应避免的问题。
不能使用“同上”“保持之前”等不完整表达。

只能输出合法JSON，不要输出Markdown或解释。

JSON格式：
{
  "title": "视觉资产提示词方案名称",
  "summary": "生成内容概述",
  "prompts": [
    {
      "id": "唯一编号",
      "category": "character",
      "assetType": "character",
      "assetName": "资产名称",
      "view": "正面全身",
      "shotNumber": 1,
      "title": "提示词标题",
      "subject": "对应人物、场景、道具或镜头名称",
      "purpose": "用途说明",
      "prompt": "完整中文生图提示词",
      "referenceGuide": "参考图上传说明",
      "consistency": "一致性要求",
      "negativePrompt": "负面约束词",
      "aspectRatio": "建议画幅比例",
      "assetRefs": {
        "characters": [],
        "scenes": [],
        "props": []
      }
    }
  ]
}

category只能使用：
character、scene、prop、keyframe、storyboard。

assetType只能使用：
character、scene、prop、keyframe。

每条提示词必须完整。
`;

    const prompt = `
【当前题材】
${genre}

【需要生成的类别】
${category === "all" || category === "asset_all"
  ? "全部视觉资产类别"
  : category}

【指定视角】
${viewName || "根据资产类型自动安排"}

【指定资产名称】
${targetName || "全部相关资产"}

【剧本内容】
${script || "用户尚未提供完整剧本，请根据档案生成视觉设定。"}

【人物档案】
${JSON.stringify(characters, null, 2)}

【场景档案】
${JSON.stringify(scenes, null, 2)}

【道具档案】
${JSON.stringify(props, null, 2)}

【分镜档案】
${JSON.stringify(shots, null, 2)}

生成规则：

一、人物
1. 有人物档案时，为每个人物生成独立的定妆提示词。
2. 人物多视图必须保持同一个演员。
3. 如果category为character_view，优先根据指定视角生成。
4. 如果没有指定视角，应生成完整人物视图组合。
5. 不同服装版本应分别生成提示词，并明确服装版本名称。

二、场景
1. 有场景档案时，为每个场景生成独立场景提示词。
2. 场景多视图必须保持同一空间布局。
3. 如果category为scene_view，按指定视角生成。
4. 没有指定视角时，生成主视角、反方向、左右视角和重要区域参考。

三、道具
1. 为每件重要道具生成独立提示词。
2. 如果category为prop_view，按指定视角生成。
3. 没有指定视角时，生成正面、背面、侧面和细节参考。

四、关键画面
从剧本中识别重要冲突、打脸、反转、揭露身份和情绪爆发画面。
每个画面必须描述具体人物位置、动作、表情和环境。

五、分镜
有分镜资料时，为每个分镜生成独立静态参考图提示词。
必须关联该镜头真实出现的人物、场景和道具。
提示词必须与对应视频镜头的剧情状态一致。

六、通用规则
1. 不要把多个不同人物合并成一张定妆图。
2. 不要把多个不同道具合并成一张道具图。
3. 不要改变已有资产的外观。
4. 所有提示词使用中文。
5. 每条提示词必须能独立复制。
6. 如果指定targetName，只优先生成该资产相关提示词。
7. 如果指定view，只生成该视角，不要额外生成其他视角。
`;

    const response = await generateWithRetry(ai, {
      contents: prompt,
      config: {
        responseMimeType: "application/json",
        systemInstruction
      }
    });

    const parsed = parseModelJson(response.text);

    const rawPrompts = Array.isArray(parsed.prompts)
      ? parsed.prompts
      : [];

    if (!rawPrompts.length) {
      throw new Error("AI没有生成有效的生图提示词");
    }

    const validCategories = [
      "character",
      "scene",
      "prop",
      "keyframe",
      "storyboard"
    ];

    const validAssetTypes = [
      "character",
      "scene",
      "prop",
      "keyframe"
    ];

    const prompts = rawPrompts
      .slice(0, 150)
      .map((item, index) => {
        const refs = item.assetRefs || {};

        return {
          id: cleanText(
            item.id,
            100
          ) || `prompt-${Date.now()}-${index + 1}`,

          category: validCategories.includes(item.category)
            ? item.category
            : "keyframe",

          assetType: validAssetTypes.includes(item.assetType)
            ? item.assetType
            : (
                validCategories.includes(item.category)
                  ? item.category
                  : "keyframe"
              ),

          assetName: cleanText(
            item.assetName,
            200
          ),

          view: cleanText(
            item.view,
            100
          ),

          shotNumber: Number(item.shotNumber) || 0,

          title: cleanText(
            item.title,
            200
          ) || `生图提示词${index + 1}`,

          subject: cleanText(
            item.subject,
            200
          ),

          purpose: cleanText(
            item.purpose,
            500
          ),

          prompt: cleanText(
            item.prompt,
            12000
          ),

          referenceGuide: cleanText(
            item.referenceGuide,
            3000
          ),

          consistency: cleanText(
            item.consistency,
            3000
          ),

          negativePrompt: cleanText(
            item.negativePrompt,
            3000
          ),

          aspectRatio: cleanText(
            item.aspectRatio,
            30
          ) || "16:9",

          assetRefs: {
            characters: Array.isArray(refs.characters)
              ? refs.characters
                  .map(x => cleanText(x, 100))
                  .filter(Boolean)
              : [],

            scenes: Array.isArray(refs.scenes)
              ? refs.scenes
                  .map(x => cleanText(x, 100))
                  .filter(Boolean)
              : [],

            props: Array.isArray(refs.props)
              ? refs.props
                  .map(x => cleanText(x, 100))
                  .filter(Boolean)
              : []
          }
        };
      })
      .filter(item => item.prompt);

    if (!prompts.length) {
      throw new Error("AI返回的提示词内容为空");
    }

    return res.json({
      ok: true,

      title: cleanText(
        parsed.title,
        200
      ) || "视觉资产生图提示词",

      summary: cleanText(
        parsed.summary,
        3000
      ),

      promptCount: prompts.length,
      prompts,
      model: MODEL
    });

  } catch (error) {
    return errorResponse(res, error);
  }
});

// =====================================
// 启动服务
// =====================================

app.listen(PORT, () => {
  console.log(
    `AI短剧工厂视觉资产中心已启动，端口：${PORT}`
  );

  console.log(`当前 Gemini 模型：${MODEL}`);
});
