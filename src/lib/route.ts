/**
 * 画面の切りかえ。
 *
 * ルーティングのライブラリは入れていない。理由は2つ。
 *
 * 1. GitHub Pages には「どのURLでも index.html を返す」設定が無い。
 *    ふつうのパス（/support）で直リンクを配ると 404 になる。
 *    ハッシュ（#/support）なら、サーバーから見ればいつも同じ1枚なので必ず開ける。
 * 2. 画面は3つしかない。そのために依存を増やすのは割に合わない。
 *
 *
 * ── 決済から戻ってくるときのこと ──
 *
 * ここは自分たちだけで完結しない。Stripe の設定した戻り先が、
 * そのままの形でこちらに届くとは限らない。実際に起こること:
 *
 *   ・戻り先に `?session_id={CHECKOUT_SESSION_ID}` が足される
 *     → #/support/thanks?session_id=cs_live_xxx のような形になる
 *   ・末尾にスラッシュが付く／大文字で入力される
 *   ・そもそもハッシュ（#より後ろ）が落ちる仕組みを通ることがある
 *
 * 完全一致で見ていると、このどれか1つで「お礼のページのはずが、
 * つくる画面が出る」ことになる。決済した直後にそれが起きるのは、
 * いちばん体験が悪い。だから
 *
 *   ・ハッシュの中の ? 以降は捨てる
 *   ・ハッシュを持たない `?thanks=1` の形でも受ける
 *
 * の両方を通す。後者は、Stripe 側に貼る戻り先として
 * ハッシュより安全な選択肢にもなる（ふつうのURLなので壊れようがない）。
 */
import { useEffect, useState } from 'react';

export type Route = 'maker' | 'support' | 'thanks';

export const ROUTE_HASH: Record<Route, string> = {
  maker: '#/',
  support: '#/support',
  thanks: '#/support/thanks',
};

/** 現在のURLから画面を決める。知らないものは、つくる画面に落とす。 */
export function readRoute(
  hash = window.location.hash,
  search = window.location.search,
): Route {
  /*
    ハッシュの中に付いてきた ? 以降（session_id など）は見ない。
    末尾のスラッシュと大文字小文字も気にしない（人が手で打つこともある）。
  */
  const h = hash.split('?')[0].replace(/\/+$/, '').toLowerCase();
  if (h === '#/support/thanks') return 'thanks';
  if (h === '#/support') return 'support';

  // ハッシュが落ちる経路のための受け口。?thanks=1 / ?support=1 でも開ける。
  if (h === '' || h === '#' || h === '#/') {
    const q = new URLSearchParams(search);
    if (q.has('thanks')) return 'thanks';
    if (q.has('support')) return 'support';
  }

  return 'maker';
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => readRoute());

  useEffect(() => {
    const onChange = () => setRoute(readRoute());
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);

  /*
    ?thanks=1 で来た人は、そのままだと戻る・進むで画面が変わらない。
    ハッシュの形に直しておくと、以後はふつうに動く。
    決済の control 番号などを URL に残さない、という意味でもこうしておきたい。
  */
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    if (!q.has('thanks') && !q.has('support')) return;
    const to: Route = q.has('thanks') ? 'thanks' : 'support';
    const { origin, pathname } = window.location;
    window.history.replaceState(null, '', `${origin}${pathname}${ROUTE_HASH[to]}`);
    setRoute(to);
  }, []);

  return route;
}

/** 画面を移る。戻るボタンで戻れるように、履歴には残す。 */
export function navigate(route: Route) {
  window.location.hash = ROUTE_HASH[route];
  window.scrollTo({ top: 0 });
}
