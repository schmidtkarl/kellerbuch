// ── Cloudflare Worker — Anthropic API proxy ──────────────────────────────────
// Deployed at: https://kellerbuch-proxy.karljasperschmidt.workers.dev
// Purpose: Safari blocks direct browser fetch() calls to api.anthropic.com (CORS).
// This worker runs server-side, calls Anthropic without CORS issues, and
// passes the response back to the browser with proper CORS headers attached.
// Edit via: Cloudflare dashboard → Workers & Pages → kellerbuch-proxy → Edit code

export default {
  async fetch(request) {
    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, x-api-key, anthropic-version",
        },
      });
    }

    if (request.method !== "POST") {
      return new Response("Only POST allowed", { status: 405 });
    }

    try {
      const apiKey = request.headers.get("x-api-key");
      const body = await request.text();

      const anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: body,
      });

      const responseText = await anthropicRes.text();

      return new Response(responseText, {
        status: anthropicRes.status,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: { message: err.message } }), {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      });
    }
  },
};
