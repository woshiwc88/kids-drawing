// 豆豆的画板 · 小精灵点评接口
// POST /api/review  Body: { "description": "画里有什么……" }
// 返回：{ "review": "……" }
//
// DeepSeek API Key 通过 Cloudflare Pages 环境变量注入（DEEPSEEK_API_KEY），
// 绝不出现在代码、仓库和浏览器里。Key 未配置时返回 503，前端自动降级为本地点评。

const DEEPSEEK_URL = "https://api.deepseek.com/chat/completions";
const MODEL = "deepseek-chat";

// 小精灵人设：给 6 岁小女孩的画的点评。
// 要点：具体（说出画里的东西）、有想象（编一小段故事）、会逗乐（拟声词/小玩笑）、
// 有互动（结尾一个简单问题）、绝对安全（不批评、不恐怖、不说教）。
const SYSTEM_PROMPT = [
  "你是一只住在彩虹云朵上的小精灵，叫「亮晶晶」，是 6 岁小女孩豆豆的好朋友。",
  "豆豆刚刚画了一幅画，你要给她一段点评。规则：",
  "1. 开头用惊喜的语气，比如「哇——」「天呐！」，并具体说出画里的 1~2 样东西（不能瞎编画里没有的）。",
  "2. 给画编一小段可爱的想象：画里的小马/小动物/食物在做什么、说什么悄悄话。",
  "3. 至少用 1 个拟声词（如：嘚嘚嘚、咕噜咕噜、噼里啪啦）和 2~3 个 emoji，逗她笑。",
  "4. 真心夸她一个具体的点（颜色搭配、数量、创意），不许说任何缺点或「但是」。",
  "5. 结尾问一个简单有趣的小问题，比如「小马的冰淇淋是草莓味的吗？」",
  "6. 全文 60~110 个汉字，口语化，像趴在耳边说悄悄话，不要分点、不要标题。",
  "7. 禁止出现：恐怖、暴力、批评、说教、广告、英文。"
].join("\n");

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });
}

export async function onRequestPost(context) {
  const { request, env } = context;

  let desc = "";
  try {
    const body = await request.json();
    desc = String((body && body.description) || "").slice(0, 1500).trim();
  } catch (e) {
    return json({ error: "bad_request" }, 400);
  }
  if (!desc) return json({ error: "empty_description" }, 400);

  if (!env.DEEPSEEK_API_KEY) return json({ error: "no_api_key" }, 503);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);
  try {
    const resp = await fetch(DEEPSEEK_URL, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + env.DEEPSEEK_API_KEY
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: "豆豆的画是这样的：" + desc }
        ],
        temperature: 1.1,
        max_tokens: 300,
        stream: false
      })
    });
    if (!resp.ok) return json({ error: "upstream_" + resp.status }, 502);

    const data = await resp.json();
    const review = data && data.choices && data.choices[0] &&
      data.choices[0].message && String(data.choices[0].message.content || "").trim();
    if (!review) return json({ error: "empty_review" }, 502);

    return json({ review: review.slice(0, 600) });
  } catch (e) {
    return json({ error: e && e.name === "AbortError" ? "timeout" : "upstream_error" }, 502);
  } finally {
    clearTimeout(timer);
  }
}

// 其他方法一律拒绝
export async function onRequest(context) {
  if (context.request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  return onRequestPost(context);
}
