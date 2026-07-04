// Deno Deploy version of the ElevenLabs TTS proxy - keeps the API key
// server-side (as a Deno Deploy environment variable) instead of shipping
// it in the public index.html. Paste this into a Deno Deploy Playground
// project; no build step or repo connection required.
//
// Routes:
//   GET  /voices        -> proxies GET  https://api.elevenlabs.io/v1/voices
//   POST /tts/:voiceId   -> proxies POST https://api.elevenlabs.io/v1/text-to-speech/:voiceId

const ALLOWED_ORIGIN = "https://averagedude18.github.io";

function corsHeaders(): HeadersInit {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const ELEVEN_API_KEY = Deno.env.get("ELEVEN_API_KEY") ?? "";

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

  return new Response("Not found", { status: 404, headers: corsHeaders() });
});
