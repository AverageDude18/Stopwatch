// Deno Deploy version of the ElevenLabs TTS proxy - keeps the API key
// server-side (as a Deno Deploy environment variable) instead of shipping
// it in the public index.html. Paste this into a Deno Deploy Playground
// project; no build step or repo connection required.
//
// Also doubles as the Web Push sender, since it's the only server-side piece
// this project has and already has the right secrets-management setup.
//
// Written in plain JavaScript (no type annotations) rather than TypeScript -
// the Deno Deploy Playground's parser rejected TS generic/type syntax here
// (e.g. `Record<string, [string, string, string]>`), so this sidesteps that
// instead of chasing which specific construct it didn't like.
//
// Routes:
//   GET  /voices        -> proxies GET  https://api.elevenlabs.io/v1/voices
//   POST /tts/:voiceId   -> proxies POST https://api.elevenlabs.io/v1/text-to-speech/:voiceId
//   POST /notify         -> sends a Web Push notification to one user
//
// Required secrets (Deno Deploy > Settings > Environment Variables):
//   ELEVEN_API_KEY            - existing, for TTS
//   SUPABASE_SERVICE_ROLE_KEY - from Supabase dashboard > Project Settings >
//                               API > service_role key. Bypasses RLS - only
//                               ever used here, never sent to the client.
//   VAPID_PRIVATE_KEY         - private half of the Web Push VAPID key pair.
//                               The public half is not a secret, it's baked
//                               into index.html's VAPID_PUBLIC_KEY constant.

import webpush from "npm:web-push@3";

const ALLOWED_ORIGIN = "https://averagedude18.github.io";
const SUPABASE_URL = "https://qnzrkcqbzmmxxzawwwat.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFuenJrY3Fiem1teHh6YXd3d2F0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODMxMTI0OTUsImV4cCI6MjA5ODY4ODQ5NX0.Tf3IFNL1pbh1TBRBx-PYBwXFGE0Le8_GjjC1Zt6BVxY";
const VAPID_PUBLIC_KEY = "BM6TgAgla-Vly6wB0AfQ6oXzU5IYd1bgW1ZGPaP9A9AIFbjiWlAilNlDCJivv7HCk3piscZl0VOmvu2LfgjUfX4";

// Escalating streak-reminder text, one triple (12:00 / 18:00 / 22:00 tone) per
// app language. This runs on its own schedule (Deno.cron below) rather than
// in response to a client request, so - unlike the reaction notification,
// which the client builds using its own translations - the text has to live
// here instead.
const STREAK_MESSAGES = {
  nl: [
    "Laat je streak van {n} niet verloren gaan vandaag!",
    "Nog niet getraind vandaag? Je streak van {n} loopt gevaar!",
    "PAS OP: OM 00:00 RAAK JE JE STREAK VAN {n} KWIJT!!!",
  ],
  en: [
    "Don't let your streak of {n} slip away today!",
    "Haven't trained today? Your streak of {n} is at risk!",
    "WARNING: AT MIDNIGHT YOU'LL LOSE YOUR STREAK OF {n}!!!",
  ],
  de: [
    "Lass deine Serie von {n} heute nicht verstreichen!",
    "Noch nicht trainiert heute? Deine Serie von {n} ist in Gefahr!",
    "ACHTUNG: UM MITTERNACHT VERLIERST DU DEINE SERIE VON {n}!!!",
  ],
  es: [
    "¡No dejes que tu racha de {n} se pierda hoy!",
    "¿Aún no has entrenado hoy? ¡Tu racha de {n} está en peligro!",
    "¡ATENCIÓN: A MEDIANOCHE PERDERÁS TU RACHA DE {n}!!!",
  ],
  fr: [
    "Ne laisse pas ta série de {n} s'arrêter aujourd'hui !",
    "Pas encore entraîné aujourd'hui ? Ta série de {n} est en danger !",
    "ATTENTION : À MINUIT TU VAS PERDRE TA SÉRIE DE {n} !!!",
  ],
  pt: [
    "Não deixes a tua sequência de {n} perder-se hoje!",
    "Ainda não treinaste hoje? A tua sequência de {n} está em risco!",
    "ATENÇÃO: À MEIA-NOITE VAIS PERDER A TUA SEQUÊNCIA DE {n}!!!",
  ],
  ru: [
    "Не дай своей серии из {n} прерваться сегодня!",
    "Ещё не тренировался сегодня? Твоя серия из {n} под угрозой!",
    "ВНИМАНИЕ: В ПОЛНОЧЬ ТЫ ПОТЕРЯЕШЬ СВОЮ СЕРИЮ ИЗ {n}!!!",
  ],
  zh: [
    "别让你连续{n}天的记录今天中断！",
    "今天还没训练？你连续{n}天的记录岌岌可危！",
    "警告：到了午夜你将失去连续{n}天的记录！！！",
  ],
  hi: [
    "आज अपनी {n} दिनों की स्ट्रीक मत खोना!",
    "आज अभी तक ट्रेनिंग नहीं की? आपकी {n} दिनों की स्ट्रीक खतरे में है!",
    "ध्यान दें: आधी रात को आप अपनी {n} दिनों की स्ट्रीक खो देंगे!!!",
  ],
  ar: [
    "لا تدع سلسلة الـ {n} يوم تضيع اليوم!",
    "لم تتدرب بعد اليوم؟ سلسلتك المكونة من {n} يوم في خطر!",
    "تحذير: عند منتصف الليل ستفقد سلسلتك المكونة من {n} يوم!!!",
  ],
};

function streakMessage(lang, tier, n) {
  const templates = STREAK_MESSAGES[lang] || STREAK_MESSAGES.nl;
  return templates[tier].replace("{n}", String(n));
}

// Intl's timeZone support handles CET/CEST DST transitions correctly, unlike
// a fixed UTC offset would.
function amsterdamHour(date) {
  const fmt = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Amsterdam", hour: "2-digit", hour12: false });
  return parseInt(fmt.format(date), 10);
}
function amsterdamDateStr(date) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Amsterdam" }).format(date);
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

function jsonResponse(body, status) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: { ...corsHeaders(), "Content-Type": "application/json" },
  });
}

// Confirms the caller actually holds a valid Supabase session, so /notify
// can't be used to spam arbitrary users by anyone who finds the URL - the
// caller doesn't need to prove anything about to_user_id, just that they are
// SOME logged-in user of the app.
async function verifyAccessToken(token) {
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { Authorization: `Bearer ${token}`, apikey: SUPABASE_ANON_KEY },
    });
    return res.ok;
  } catch (e) {
    return false;
  }
}

async function supabaseServiceRequest(path, init) {
  init = init || {};
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
}

async function sendPushToUser(userId, payload) {
  const res = await supabaseServiceRequest(
    `push_subscriptions?user_id=eq.${encodeURIComponent(userId)}&select=endpoint,p256dh,auth`,
  );
  if (!res.ok) return;
  const subs = await res.json();
  const text = JSON.stringify(payload);

  await Promise.all(subs.map(async (sub) => {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        text,
      );
    } catch (err) {
      // 404/410 means the push service considers this endpoint gone for
      // good (uninstalled, expired) - clean it up instead of retrying it
      // forever on every future notification.
      const statusCode = err && err.statusCode;
      if (statusCode === 404 || statusCode === 410) {
        await supabaseServiceRequest(
          `push_subscriptions?endpoint=eq.${encodeURIComponent(sub.endpoint)}`,
          { method: "DELETE" },
        );
      }
    }
  }));
}

webpush.setVapidDetails(
  "mailto:idsgrunstra10@gmail.com",
  VAPID_PUBLIC_KEY,
  Deno.env.get("VAPID_PRIVATE_KEY") || "",
);

// Runs every hour; only actually sends anything at Amsterdam-local 12:00,
// 18:00, and 22:00 (index 0/1/2 into STREAK_MESSAGES' escalating tiers).
// Skips anyone with current_streak = 0 - there's nothing to "not lose" yet,
// so that message wouldn't make sense.
Deno.cron("streak-reminder", "0 * * * *", async () => {
  const now = new Date();
  const tierByHour = { 12: 0, 18: 1, 22: 2 };
  const hour = amsterdamHour(now);
  if (!(hour in tierByHour)) return;
  const tier = tierByHour[hour];
  const today = amsterdamDateStr(now);

  const res = await supabaseServiceRequest(
    "leaderboard_stats?select=user_id,current_streak,last_trained_date,app_language&current_streak=gt.0",
  );
  if (!res.ok) return;
  const rows = await res.json();

  await Promise.all(
    rows
      .filter((r) => r.last_trained_date !== today)
      .map((r) =>
        sendPushToUser(r.user_id, {
          title: "Trainingspartner",
          body: streakMessage(r.app_language, tier, r.current_streak),
        })
      ),
  );
});

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const ELEVEN_API_KEY = Deno.env.get("ELEVEN_API_KEY") || "";

  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders() });
  }

  if (url.pathname === "/voices" && req.method === "GET") {
    const upstream = await fetch("https://api.elevenlabs.io/v1/voices", {
      headers: { "xi-api-key": ELEVEN_API_KEY },
    });
    const body = await upstream.text();
    return new Response(body, {
      status: upstream.status,
      headers: { ...corsHeaders(), "Content-Type": "application/json" },
    });
  }

  if (url.pathname.startsWith("/tts/") && req.method === "POST") {
    const voiceId = url.pathname.slice("/tts/".length);
    const payload = await req.text();
    const upstream = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
      {
        method: "POST",
        headers: {
          "xi-api-key": ELEVEN_API_KEY,
          "Content-Type": "application/json",
        },
        body: payload,
      },
    );
    return new Response(upstream.body, {
      status: upstream.status,
      headers: { ...corsHeaders(), "Content-Type": "audio/mpeg" },
    });
  }

  if (url.pathname === "/notify" && req.method === "POST") {
    const authHeader = req.headers.get("Authorization") || "";
    const token = authHeader.replace(/^Bearer\s+/i, "");
    if (!token || !(await verifyAccessToken(token))) {
      return jsonResponse({ error: "Unauthorized" }, 401);
    }
    const body = await req.json().catch(() => null);
    if (!body || typeof body.to_user_id !== "string" || typeof body.title !== "string") {
      return jsonResponse({ error: "Bad request" }, 400);
    }
    await sendPushToUser(body.to_user_id, {
      title: body.title,
      body: typeof body.body === "string" ? body.body : "",
      url: typeof body.url === "string" ? body.url : "./",
    });
    return jsonResponse({ ok: true });
  }

  return new Response("Not found", { status: 404, headers: corsHeaders() });
});
