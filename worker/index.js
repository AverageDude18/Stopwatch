// Cloudflare Worker: proxies ElevenLabs requests so the API key never has to
// live in the public index.html. Deploy this via the Cloudflare dashboard
// (Workers & Pages > Create Worker > paste this in) and set ELEVEN_API_KEY
// as an encrypted secret in the Worker's Settings > Variables tab.
//
// Routes:
//   GET  /voices        -> proxies GET  https://api.elevenlabs.io/v1/voices
//   POST /tts/:voiceId   -> proxies POST https://api.elevenlabs.io/v1/text-to-speech/:voiceId

const ALLOWED_ORIGIN = 'https://averagedude18.github.io';

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }

    if (url.pathname === '/voices' && request.method === 'GET') {
      const upstream = await fetch('https://api.elevenlabs.io/v1/voices', {
        headers: { 'xi-api-key': env.ELEVEN_API_KEY },
      });
      const body = await upstream.text();
      return new Response(body, {
        status: upstream.status,
        headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
      });
    }

    if (url.pathname.startsWith('/tts/') && request.method === 'POST') {
      const voiceId = url.pathname.slice('/tts/'.length);
      const payload = await request.text();
      const upstream = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
        method: 'POST',
        headers: {
          'xi-api-key': env.ELEVEN_API_KEY,
          'Content-Type': 'application/json',
        },
        body: payload,
      });
      return new Response(upstream.body, {
        status: upstream.status,
        headers: { ...corsHeaders(), 'Content-Type': 'audio/mpeg' },
      });
    }

    return new Response('Not found', { status: 404, headers: corsHeaders() });
  },
};
