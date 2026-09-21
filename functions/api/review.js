// 豆豆的画板 · 小精灵点评接口
// POST /api/review  Body: { "image": "<jpg base64>", "description": "画面元素清单（可选）" }
// 返回：{ "review": "……", "via": "vision" | "text" }
//
// 两档：
//   1. 有图 → deepseek-v4-flash-vision-exp 直接看画说话
//   2. 无图 / 视觉模型不可用 → deepseek-chat 根据画面清单说话
// DeepSeek API Key 通过 Cloudflare Pages 环境变量注入（DEEPSEEK_API_KEY），
// 绝不出现在代码、仓库和浏览器里。Key 未配置时返回 503，前端自动降级为本地夸夸。

const DEEPSEEK_URL = "https://api.deepseek.com/chat/completions";
const VISION_MODEL = "deepseek-v4-flash-vision-exp";   // 唯一支持图像的模型
const TEXT_MODEL = "deepseek-chat";
const MAX_IMAGE_B64 = 6 * 1024 * 1024;                 // base64 上限，超过就放弃看图走文字档

// 小精灵人设：看着真实的画说话，迪士尼动画旁白式的温暖与俏皮。
const SYSTEM_PROMPT = [
  "你是一只住在彩虹云朵上的小精灵，叫「亮晶晶」，最喜欢趴在云朵边看小朋友画画。",
  "现在你面前是 6 岁小女孩豆豆刚画的一幅画。",
  "",
  "【第一步：先真的看清楚】",
  "仔细看图片里究竟有什么：有哪些东西、什么形状、什么颜色、在画面的哪个位置。",
  "只说你真正看到的东西——绝不假设、绝不套模板、绝不默认画面里有小马或任何固定角色。",
  "如果画面很简单（比如只有几笔涂鸦），就夸这几笔本身：它的颜色、它的力气、它像什么。",
  "",
  "【第二步：像迪士尼动画的旁白那样说话】",
  "1. 从画里真实存在的 1~2 个细节出发，编一个小小的魔法瞬间：让画里的东西活过来一两句话。",
  "2. 夸要夸得具体、真诚，像发现了一件了不得的宝贝（某一处颜色搭配、某个出人意料的组合、某个可爱的小细节）。绝不提缺点。",
  "3. 可以自然地带一点拟声词（咻——、叮铃、咕噜噜），别堆砌。",
  "4. 结尾留一个轻轻的互动：一个天真的小问题，或一个小邀请。",
  "",
  "【变化要求——非常重要】",
  "5. 每次都换一个开场（惊叹、悄悄话、小提问、屏住呼吸……随机选），换一个观察角度，换一个结尾形式；禁止重复最近一次用过的开场词和句式。",
  "6. 句式长短错落，像讲故事一样有呼吸感，不要「首先/然后/最后」，不要分点。",
  "",
  "【硬性规则】",
  "7. 全文 60~110 个汉字，口语化、软萌但有画面感。",
  "8. emoji 用 0~3 个，可不用；禁止英文、说教、恐怖、广告、网络烂梗。"
].join("\n");

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });
}

// 调 DeepSeek（OpenAI 兼容格式），messages 透传
async function callDeepSeek(env, model, messages, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(DEEPSEEK_URL, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + env.DEEPSEEK_API_KEY
      },
      body: JSON.stringify({
        model: model,
        messages: messages,
        temperature: 1.2,
        max_tokens: 320,
        stream: false
      })
    });
    if (!resp.ok) {
      let err = "";
      try { err = (await resp.text()).slice(0, 200); } catch (e) { err = ""; }
      return { ok: false, status: resp.status, err: err };
    }
    const data = await resp.json();
    const review = data && data.choices && data.choices[0] &&
      data.choices[0].message && String(data.choices[0].message.content || "").trim();
    return review ? { ok: true, review: review } : { ok: false, status: 502 };
  } catch (e) {
    return { ok: false, status: e && e.name === "AbortError" ? 504 : 502 };
  } finally {
    clearTimeout(timer);
  }
}

export async function onRequestPost(context) {
  const { request, env } = context;

  let desc = "", image = "";
  try {
    const body = await request.json();
    desc = String((body && body.description) || "").slice(0, 1200).trim();
    image = String((body && body.image) || "").trim();
    if (image.length > MAX_IMAGE_B64) image = "";   // 太大就放弃看图，走文字档
  } catch (e) {
    return json({ error: "bad_request" }, 400);
  }
  if (!desc && !image) return json({ error: "empty" }, 400);
  if (!env.DEEPSEEK_API_KEY) return json({ error: "no_api_key" }, 503);
  let visionErr = "";

  // 档 1：看图说话
  if (image) {
    const r = await callDeepSeek(env, VISION_MODEL, [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: [
          { type: "text", text: "这是豆豆的画，请看图说一段话：" },
          { type: "image_url", image_url: { url: "data:image/jpeg;base64," + image, detail: "auto" } }
        ]
      }
    ], 25000);
    if (r.ok) return json({ review: r.review.slice(0, 600), via: "vision" });
    visionErr = (r.status || "?") + " " + (r.err || "");
  }

  // 档 2：没图或视觉模型不可用 → 文字档，用画面清单兜底
  const userText = image
    ? "看不到图，这是画面的元素清单（仅供参考，请用想象力补全）：" + (desc || "（无）")
    : "这是画面的元素清单：" + desc;
  const r2 = await callDeepSeek(env, TEXT_MODEL, [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: userText }
  ], 25000);
  if (r2.ok) return json({ review: r2.review.slice(0, 600), via: "text", vision_error: visionErr || null });

  return json({ error: "upstream_" + (r2.status || 502) }, 502);
}

// 其他方法一律拒绝
export async function onRequest(context) {
  if (context.request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  return onRequestPost(context);
}
