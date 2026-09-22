/**
 * フレームをリンクで配る。
 *
 * ── なぜ置き場所が要るのか ──
 *
 * ファイルで配る道はもうある（`src/lib/recipe.ts`）。置き場所が要らないのが利点だが、
 * もらう側の手数が多い。
 *
 *   ファイル : 長押しで保存 → アプリを開く → 写真 → 「フレームをえらぶ」
 *              → さっき保存したものを探す → 調整 → 保存      （6〜7手）
 *   リンク   : リンクを押す → 写真をえらぶ → 保存              （3手）
 *
 * 配る相手の年齢も慣れもばらばらなので、この差は大きい。
 *
 * 「リンクの中に絵を全部入れる」は成り立たない。フレームは実測30〜270KB、
 * base64 で40〜360KBのURLになる。Discord の1通は2000文字で、桁が2つ足りない。
 * だから**絵はどこかに置く**しかない。
 *
 * ── 約束をどう守るか ──
 *
 * この道具は「あなたの写真はこの端末の中だけで処理されます」と言っている。
 * ここで送るのは**フレームだけ**で、利用者の写真は1バイトも出ない。
 * しかもフレームを送るのは、作った人が「リンクを作る」を押したときだけ。
 * 黙って送るものは1つも無い。
 *
 * ── 送り先が無いときは、機能ごと無い ──
 *
 * `VITE_FRAME_API` が空なら `SHARE_ON` が false になり、リンクまわりは
 * 画面にも出ない。お礼（チップ）と同じ扱い。設定していない状態で
 * 「押せないボタン」を見せない。
 */

/**
 * 置き場所の住所。**ここを書き換えるだけで出せる。**
 *
 * ── なぜ GitHub の変数ではなく、ここなのか ──
 *
 * お礼の送り先（TIP_URL）を変数にしたのは、決済リンクをリポジトリに
 * 書きたくなかったから。ここはただの公開URLで、隠す理由が無い。
 *
 * 変数にすると、設定するのに GitHub の画面を触る必要がある。
 * ここに書いてあれば**コードを1行直して出す**だけで済む。
 *
 * ── それでも変数を残してある理由 ──
 *
 * 止めるときに使う。`FRAME_API` に `off` のような URL でないものを入れれば、
 * 下の `usable` が弾いて機能ごと消える。**コードを直さずに、すぐ止められる。**
 * 荒らされたときに「直す人を待つ」状態を作らない。
 */
const BUILT_IN = 'https://ae-frame-store.aura-aevisual.workers.dev';

/*
  変数が入っていればそちらが勝つ。空（設定していない）なら上の既定を使う。

  `??` ではなく `||` なのは、GitHub Actions が「設定していない変数」を
  空文字で渡してくるから。`??` だと空文字も「値がある」と見なして、
  既定に落ちてこない。
*/
const RAW = import.meta.env.VITE_FRAME_API || BUILT_IN;

function usable(url: string): boolean {
  if (!url) return false;
  try {
    const u = new URL(url);
    if (u.protocol === 'https:') return true;
    /*
      手もとの検証用に localhost だけ http を通す。

      ブラウザ自身も localhost は「安全な場所」として扱う（混ざりものの
      警告を出さない）ので、ここだけ例外にしても外向きの守りは緩まない。
      公開先で http を指したら、この関数が弾いて機能ごと消える。
    */
    return u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1');
  } catch {
    return false;
  }
}

/**
 * 相談・通報の受け口。
 *
 * ── なぜ要るのか ──
 *
 * リンクで配るというのは、**他人の絵を預かる**ということ。
 * 配信者向けのフレームは、アニメやゲームの絵を元にしたものが多い。
 * 「これ、うちのキャラだよね」という連絡は、法律の話より先に来る。
 *
 * 規模によらず残るのは「**連絡が取れること**」と「**言われたら消せること**」。
 * 消しかたは docs/frame-link-setup.md にある。ここは連絡が取れるほうの受け持ち。
 *
 * ── なぜ新しく作らないのか ──
 *
 * すでにある窓口を使う。専用の受け口を作ると、見る場所が1つ増えて、
 * **見落とす場所も1つ増える**。届いても気づかない窓口は、無いのと同じ。
 *
 * ── なぜ変数にしないのか ──
 *
 * お礼の送り先（TIP_URL）は、審査や停止の都合で差し替えたい事情があった。
 * ここはただの公開ページなので、変える理由が出たらコードを直せばよい。
 */
export const CONTACT_URL = 'https://kazuworks.net/contact';

/**
 * この道具そのものの入口。
 *
 * リンクで来た人は、フレームを1枚もらっただけで、この道具を知らない。
 * 「自分でも作ってみたい」と思った人のために、行き先を1つ置いておく。
 * ハッシュを付けない`#/`なしの住所にして、もらったフレームの画面から離れる。
 */
export const TOOL_URL = 'https://kazuya-3.github.io/ae-Frame/';

/** 送り先。末尾のスラッシュは落としておく（つなぐときに二重にならないように） */
export const FRAME_API = usable(RAW) ? RAW.replace(/\/+$/, '') : '';
export const SHARE_ON = FRAME_API !== '';

/**
 * 置けるフレームの上限。
 *
 * 実測でフレームは30〜270KB。2MBあれば、よほど凝ったものでも通る。
 * 上限を置くのは、置き場所を守るためというより、
 * **間違って写真を送ってしまう形**を作らないため。
 */
export const MAX_FRAME_BYTES = 2 * 1024 * 1024;

/**
 * リンクのかけら（`#/f/<id>` の id）。
 *
 * 英数字だけに絞る。ここを緩めると、URL に書いたものがそのまま
 * 送り先のパスに入る形になる。
 */
const ID = /^[A-Za-z0-9_-]{4,40}$/;

export function validId(id: string): boolean {
  return ID.test(id);
}

/** フレームを置いて、リンクのかけらをもらう。 */
export async function putFrame(blob: Blob): Promise<string> {
  if (!SHARE_ON) throw new Error('リンクの送り先が設定されていません');
  if (blob.size > MAX_FRAME_BYTES) throw new Error('このフレームは大きすぎます');
  const res = await fetch(`${FRAME_API}/f`, {
    method: 'POST',
    headers: { 'content-type': 'image/png' },
    body: blob,
  });
  if (!res.ok) throw new Error(`置けませんでした（${res.status}）`);
  const data = (await res.json()) as { id?: unknown };
  const id = typeof data?.id === 'string' ? data.id : '';
  if (!validId(id)) throw new Error('返ってきた合言葉が読めませんでした');
  return id;
}

/** 置いてあるフレームを取ってくる。無ければ null（行き止まりにしない）。 */
export async function getFrame(id: string): Promise<Blob | null> {
  if (!SHARE_ON || !validId(id)) return null;
  const res = await fetch(`${FRAME_API}/f/${id}`);
  if (res.status === 404 || res.status === 410) return null;
  if (!res.ok) throw new Error(`取ってこられませんでした（${res.status}）`);
  const blob = await res.blob();
  if (blob.size > MAX_FRAME_BYTES) return null;
  return blob;
}

/** 配るリンク。いま開いているページの住所に、かけらを足して作る。 */
export function frameLink(id: string): string {
  const { origin, pathname } = window.location;
  return `${origin}${pathname}#/f/${id}`;
}
