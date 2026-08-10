/**
 * 画面の切りかえ。
 *
 * ルーティングのライブラリは入れていない。理由は2つ。
 *
 * 1. GitHub Pages には「どのURLでも index.html を返す」設定が無い。
 *    ふつうのパス（/support）で直リンクを配ると 404 になる。
 *    ハッシュ（#/support）なら、サーバーから見ればいつも同じ1枚なので必ず開ける。
 * 2. 画面は3つしかない。そのために依存を増やすのは割に合わない。
 */
import { useEffect, useState } from 'react';

export type Route = 'maker' | 'support' | 'thanks';

export const ROUTE_HASH: Record<Route, string> = {
  maker: '#/',
  support: '#/support',
  thanks: '#/support/thanks',
};

/** 現在のハッシュから画面を決める。知らないものは、つくる画面に落とす。 */
export function readRoute(hash = window.location.hash): Route {
  // 末尾のスラッシュと大文字小文字は気にしない（人が手で打つこともある）
  const h = hash.replace(/\/+$/, '').toLowerCase();
  if (h === '#/support/thanks') return 'thanks';
  if (h === '#/support') return 'support';
  return 'maker';
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => readRoute());

  useEffect(() => {
    const onChange = () => setRoute(readRoute());
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);

  return route;
}

/** 画面を移る。戻るボタンで戻れるように、履歴には残す。 */
export function navigate(route: Route) {
  window.location.hash = ROUTE_HASH[route];
  window.scrollTo({ top: 0 });
}
