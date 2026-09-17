/**
 * フレームの置き場所（Cloudflare Worker + KV）。
 *
 * ここに置くのは**背景をけしたフレームのPNGだけ**。
 * 利用者の写真は1バイトも来ない（送っているのは、配る人が「リンクを作る」を
 * 押したときの、そのフレームだけ）。
 *
 * ── 作りの決まり ──
 *
 * 1. **一覧を作らない。** 並べて見せる場所にしない。リンクを知っている人だけが開ける。
 *    棚に並べた瞬間、「集めて見せている場所」になり、話がまるごと変わる。
 * 2. **期限を切る。** 90日。枠ごとのフレームなら、期限があるほうが自然。
 *    KV の expirationTtl に任せるので、掃除の仕組みを自分で持たない。
 * 3. **PNG しか受けない。** 先頭のバイトを見て確かめる。
 *    拡張子や content-type の自己申告は当てにしない。
 * 4. **大きすぎるものを受けない。** 2MB。
 *
 * ── 置きかた（初めての人向け） ──
 *
 * 手順は docs/frame-link-setup.md にある。だいたい10分。
 */

const MAX_BYTES = 2 * 1024 * 1024;
const TTL_SECONDS = 90 * 24 * 60 * 60;
const PNG_MAGIC = [137, 80, 78, 71, 13, 10, 26, 10];

/** 合言葉。短くて、打ち間違えにくい文字だけ使う */
function newId() {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return [...bytes].map((b) => 'abcdefghijkmnpqrstuvwxyz23456789'[b & 31]).join('');
}

function cors(origin, allowed) {
  // 設定していなければ、どこからでも読める（画像を配るだけなので）
  const allow = allowed && allowed !== '*' ? allowed : '*';
  return {
    'access-control-allow-origin': allow,
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-max-age': '86400',
    vary: 'origin',
  };
}

const json = (body, status, headers) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });

export default {
  async fetch(request, env) {
    const head = cors(request.headers.get('origin'), env.ALLOW_ORIGIN);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: head });

    const url = new URL(request.url);

    // --- 置く ---
    if (request.method === 'POST' && url.pathname === '/f') {
      const body = new Uint8Array(await request.arrayBuffer());
      if (body.length === 0) return json({ error: 'empty' }, 400, head);
      if (body.length > MAX_BYTES) return json({ error: 'too-large' }, 413, head);
      if (!PNG_MAGIC.every((b, i) => body[i] === b)) return json({ error: 'not-png' }, 415, head);

      const id = newId();
      await env.FRAMES.put(id, body, { expirationTtl: TTL_SECONDS });
      return json({ id }, 201, head);
    }

    // --- 取る ---
    const got = /^\/f\/([a-z0-9]{4,40})$/.exec(url.pathname);
    if (request.method === 'GET' && got) {
      const body = await env.FRAMES.get(got[1], 'arrayBuffer');
      if (!body) return json({ error: 'gone' }, 404, head);
      return new Response(body, {
        headers: {
          ...head,
          'content-type': 'image/png',
          // 中身は変わらないので、長めに持たせてよい
          'cache-control': 'public, max-age=86400, immutable',
        },
      });
    }

    /*
      それ以外は何も答えない。

      一覧も、検索も、消しかたも置いていない。消すのは置き場所の側から
      （Cloudflare のダッシュボード、または wrangler kv key delete）。
      権利者から連絡が来たときに消せればよく、そのために外から叩ける口を
      増やす必要は無い。
    */
    return json({ error: 'not-found' }, 404, head);
  },
};
