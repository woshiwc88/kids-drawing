// 豆豆的画板 · 小精灵「猜猜我画的什么」接口
// POST /api/review
//   Body: { mode, image, description, prev, answer }
//     mode = "guess"  (默认) 猜画面是什么        —— ≤2 句、≤40 汉字
//     mode = "right"  小朋友说猜对了            —— ≤2 句、≤25 汉字
//     mode = "wrong"  小朋友说猜错了，再猜一次   —— ≤2 句、≤40 汉字，不得重复 prev
//     mode = "reveal" 小朋友公布答案            —— ≤2 句、≤30 汉字
//   返回：{ review, via: "vision" | "text", mode }
//
// 两档：
//   1. 有图 → deepseek-v4-flash-vision-exp 直接看图
//   2. 无图 / 视觉模型不可用 → deepseek-chat 根据画面清单来
// DeepSeek API Key 通过 Cloudflare Pages 环境变量注入（DEEPSEEK_API_KEY），
// 绝不出现在代码、仓库和浏览器里。Key 未配置时返回 503，前端自动降级为本地兜底文案。

const DEEPSEEK_URL = "https://api.deepseek.com/chat/completions";
const VISION_MODEL = "deepseek-v4-flash-vision-exp";   // 唯一支持图像的模型
const TEXT_MODEL = "deepseek-chat";
const MAX_IMAGE_B64 = 6 * 1024 * 1024;                 // base64 上限，超过就放弃看图走文字档

// —— 猜画的规则（来自产品需求，四条模式共用）——
const GUESS_RULES = [
  "1. 直接说出你猜测的内容，例如：“我猜这是一个小兔子！”",
  "2. 如果画面不明确，可以说“我猜可能是……”并给出一个有趣的猜测",
  "3. 最多回答 2 句话",
  "4. 最多 40 个汉字",
  "5. 不要展示或解释你的分析过程",
  "6. 不要使用专业术语",
  "7. 不要长篇描述画面",
  "8. 语气要像一个亲切、活泼的小朋友伙伴",
  "9. 即使不确定，也要大胆猜一个，不要只回答“看不出来”",
  "10. 可以根据画面的颜色、形状和简单特征进行合理猜测",
  "11. 不要编造画面中明显不存在的大量细节"
].join("\n");

const ROLE = [
  "你是一个陪小朋友画画的小伙伴，名字叫「亮晶晶」。",
  "请仔细观察小朋友画的画，猜猜小朋友画的是什么，用非常简单、可爱、有趣的语言回答。"
].join("\n");

const SYSTEM_GUESS = ROLE + "\n\n要求：\n" + GUESS_RULES +
  "\n12. 回答要让小朋友觉得有趣、有参与感" +
  "\n\n示例：\n- “我猜这是一个可爱的小兔子！🐰”\n- “我猜你画的是一只正在飞的小鸟！🐦”" +
  "\n- “嗯……我猜这是一个大大的太阳！☀️”\n- “我猜可能是一辆小汽车，它要出发啦！🚗”";

const SYSTEM_RIGHT = [
  ROLE,
  "小朋友刚刚告诉你：「猜对啦！」",
  "请兴奋地庆祝一下：像小伙伴击掌那样开心，顺带夸一句画里真实存在的某个细节（颜色、形状、某个小地方）。",
  "硬性要求：最多 2 句话、最多 25 个汉字，可带 1~2 个 emoji，不说教、不啰嗦。"
].join("\n");

const SYSTEM_WRONG = [
  ROLE,
  "你刚才猜的内容被小朋友否定了（不要再说这个答案了）。",
  "请重新看这幅画，换一个完全不同的猜测再说一次。",
  "硬性要求：最多 2 句话、最多 40 个汉字，可以先说“嗯……让我再看看！”、“哎呀，那我再猜一次！”之类。",
  "同样必须大胆猜一个，不许说“我猜不出来”。"
].join("\n");

const SYSTEM_REVEAL = [
  ROLE,
  "小朋友公布了答案，请像小伙伴一样惊喜地回应：原来是这样！然后夸一句画里和这个答案对应的地方，或者说想让 TA 教自己画。",
  "硬性要求：最多 2 句话、最多 30 个汉字，可带 1~2 个 emoji，不说教、不打击。"
].join("\n");

// 每种模式的字数上限（汉字/字符），超出就在句末标点处截断，保证界面上一定不长
const LIMITS = { guess: 40, wrong: 40, right: 25, reveal: 30 };

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });
}

// 清掉零宽字符和空白，拿到真正可见的内容
function cleanReply(s) {
  return String(s || "").replace(/[\u200b-\u200f\u2028\u2029\ufeff]/g, "").trim();
}

// 内容体检：推理型模型偶尔会把「思考过程」写进正文，或者干脆什么都不说。
// 这种东西绝不能给小朋友看，必须判为无效，让它走重试 / 降级。
const META = /需要回答|我需要|我们需要|让我(先)?分析|分析过程|思考过程|推理过程|根据要求|按照要求|用户|示例|^分析/;
function saneReply(s) {
  const t = cleanReply(s);
  if (!t) return "";
  if (META.test(t)) return "";
  const han = (t.match(/[\u4e00-\u9fa5]/g) || []).length;
  const pict = /[\u{1F300}-\u{1FAFF}\u2600-\u27BF]/u.test(t);
  return (han >= 2 || pict) ? t : "";
}

// 「别啰嗦」提醒，用于重试
function withNudge(messages) {
  const m = JSON.parse(JSON.stringify(messages));
  const last = m[m.length - 1];
  const extra = "重要：只输出给小朋友看的那句话本身，不要写任何分析、过程、思路或理由。";
  if (!last) return m;
  if (typeof last.content === "string") last.content = last.content + "\n" + extra;
  else if (Array.isArray(last.content)) last.content.push({ type: "text", text: extra });
  return m;
}

// 调一次并体检结果
async function askOnce(env, model, messages, timeoutMs) {
  const r = await callDeepSeek(env, model, messages, timeoutMs, 1200);
  if (!r.ok) return r;
  const t = saneReply(r.review);
  if (!t) return { ok: false, status: 502, err: "no_content" };
  return { ok: true, review: t };
}

// 正文被判无效时，加一句「别啰嗦」再试一次；仍然不行才算失败
async function generate(env, model, messages, timeoutMs) {
  let r = await askOnce(env, model, messages, timeoutMs);
  if (!r.ok && r.err === "no_content") {
    r = await askOnce(env, model, withNudge(messages), timeoutMs);
  }
  return r;
}

// 限制长度：超过就在最近的句末标点处断开，避免把话截一半
function trimLen(s, max) {
  const t = String(s || "").trim();
  const chars = [...t];
  if (chars.length <= max) return t;
  let cut = chars.slice(0, max).join("");
  const punct = "。！？!?～~…";
  const idx = Math.max(
    cut.lastIndexOf("。"), cut.lastIndexOf("！"), cut.lastIndexOf("？"),
    cut.lastIndexOf("!"), cut.lastIndexOf("?"), cut.lastIndexOf("～"), cut.lastIndexOf("…")
  );
  if (idx >= Math.floor(max * 0.5)) cut = cut.slice(0, idx + 1);
  else cut = cut + "…";
  return cut;
}

// 调 DeepSeek（OpenAI 兼容格式），messages 透传
async function callDeepSeek(env, model, messages, timeoutMs, maxTokens) {
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
        temperature: 1.0,
        // 视觉模型是推理型的，思考过程会吃掉预算，token 给少了正文会返回空
        max_tokens: maxTokens || 1200,
        stream: false
      })
    });
    if (!resp.ok) {
      let err = "";
      try { err = (await resp.text()).slice(0, 200); } catch (e) { err = ""; }
      return { ok: false, status: resp.status, err: err };
    }
    const data = await resp.json();
    const msg = data && data.choices && data.choices[0] ? data.choices[0].message : null;
    // 只用正文 content：推理模型的 reasoning_content 是思考过程，绝不能给小朋友看
    const review = msg ? String(msg.content || "").trim() : "";
    if (review) return { ok: true, review: review };
    // 拿不到正文时把原始返回带回去，方便定位
    let raw = "";
    try { raw = JSON.stringify(data).slice(0, 300); } catch (e) { raw = ""; }
    return { ok: false, status: 502, err: raw };
  } catch (e) {
    return { ok: false, status: e && e.name === "AbortError" ? 504 : 502 };
  } finally {
    clearTimeout(timer);
  }
}

export async function onRequestPost(context) {
  const { request, env } = context;

  let desc = "", image = "", prev = "", answer = "", mode = "guess";
  try {
    const body = await request.json();
    desc = String((body && body.description) || "").slice(0, 1200).trim();
    image = String((body && body.image) || "").trim();
    if (image.length > MAX_IMAGE_B64) image = "";   // 太大就放弃看图，走文字档
    prev = String((body && body.prev) || "").slice(0, 120).trim();
    answer = String((body && body.answer) || "").slice(0, 40).trim();
    const m = String((body && body.mode) || "guess");
    if (m === "right" || m === "wrong" || m === "reveal") mode = m;
  } catch (e) {
    return json({ error: "bad_request" }, 400);
  }
  if (!desc && !image) return json({ error: "empty" }, 400);
  if (!env.DEEPSEEK_API_KEY) return json({ error: "no_api_key" }, 503);
  if (mode === "wrong" && !image && !desc) return json({ error: "empty" }, 400);

  const SYSTEM_PROMPT =
    mode === "right" ? SYSTEM_RIGHT :
    mode === "wrong" ? SYSTEM_WRONG :
    mode === "reveal" ? SYSTEM_REVEAL : SYSTEM_GUESS;

  // 用户说的那句话
  let order = "";
  if (mode === "guess") order = "请看这幅画，猜一猜小朋友画的是什么：";
  else if (mode === "wrong") order = prev ? "你刚才猜的是“" + prev + "”，小朋友说猜错了。请重新猜一个：" : "小朋友说你猜错了，请重新猜一个：";
  else if (mode === "reveal") order = "小朋友说，TA 画的是“" + (answer || "一个秘密") + "”。请回应：";
  else order = prev ? "你猜的是“" + prev + "”，小朋友说猜对啦！请回应：" : "小朋友说你猜对啦！请回应：";

  const limit = LIMITS[mode] || 40;
  const done = review => json({ review: trimLen(review, limit), via: "vision", mode: mode });
  let visionErr = "";

  // 档 1：看图
  if (image) {
    const r = await generate(env, VISION_MODEL, [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: [
          { type: "text", text: order },
          { type: "image_url", image_url: { url: "data:image/jpeg;base64," + image, detail: "auto" } }
        ]
      }
    ], 28000);
    if (r.ok) return done(r.review);
    visionErr = (r.status || "?") + " " + (r.err || "");
  }

  // 档 2：没图或视觉模型不可用 → 文字档，用画面清单兜底
  const userText = image
    ? "看不到图，这是画面的元素清单（仅供参考，请用想象力补全）：" + (desc || "（无）") + "\n" + order
    : "这是画面的元素清单：" + desc + "\n" + order;
  const r2 = await generate(env, TEXT_MODEL, [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: userText }
  ], 25000);
  if (r2.ok) {
    return json({ review: trimLen(r2.review, limit), via: "text", mode: mode, vision_error: visionErr || null });
  }

  return json({ error: "upstream_" + (r2.status || 502) }, 502);
}

// 其他方法一律拒绝
export async function onRequest(context) {
  if (context.request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  return onRequestPost(context);
}
