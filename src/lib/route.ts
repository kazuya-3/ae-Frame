/**
 * 画面の切りかえ。
 *
 * ルーティングのライブラリは入れていない。理由は2つ。
 *
 * 1. GitHub Pages には「どのURLでも index.html を返す」設定が無い。
 *    ふつうのパス（/share）で直リンクを配ると 404 になる。
 *    ハッシュ（#/share）なら、サーバーから見ればいつも同じ1枚なので必ず開ける。
 * 2. 画面は2つしかない。そのために依存を増やすのは割に合わない。
 *
 *
 * ── 応援ページを畳んだこと ──
 *
 * 2026-08 の Stripe の審査を受けて、決済まわりを丸ごと外した。
 * 残るのは「つくる」と「知らせる」だけで、お金に触れる画面は1つも無い。
 *
 *   #/support        → 応援ページ（金額を選ぶ）      … 削除
 *   #/support/thanks → 決済のあとのお礼ページ        … 削除
 *   #/share          → 知らせるだけのページ          … いまここ
 *
 * ── それでも古いURLを受けるのはなぜか ──
 *
 * 配ったもの、貼られたもの、ブラウザに残ったブックマークは、こちらの都合で
 * 消えてくれない。#/support を開いた人に「つくる画面」が出るのは、
 * 行き先を間違えたように見える。ましてや 404 は出せない（1枚しかないので
 * 出しようがないが、意図しない画面が出るのは同じこと）。
 *
 * だから古い2つは、新しい共有ページへ静かに送る。
 * 履歴も置き換える（残すと「戻る」で無い場所へ戻ってしまう）。
 *
 * 決済からの戻り先だった `?thanks=1` / `?support=1` も同じ扱いにする。
 * 決済そのものが無いので、もう届くことはないはずだが、
 * 届いたときに壊れないほうがよい。
 */
import { useEffect, useState } from 'react';
import { TIP_ON } from './tip';

export type Route = 'maker' | 'share' | 'tip';

export const ROUTE_HASH: Record<Route, string> = {
  maker: '#/',
  share: '#/share',
  tip: '#/tip',
};

/** 共有ページへ送る、古いハッシュ。決済まわりを外す前に配ってしまったもの */
const LEGACY_HASH = ['#/support', '#/support/thanks'];

/** 共有ページへ送る、古い問い合わせ文字列。決済からの戻り先だったもの */
const LEGACY_QUERY = ['support', 'thanks'];

/** ハッシュを見くらべる形にそろえる。人が手で打つことも、機械が足すこともある */
function normalize(hash: string) {
  // ハッシュの中に付いてくる ? 以降（session_id など）は見ない。
  // 末尾のスラッシュと大文字小文字も気にしない。
  return hash.split('?')[0].replace(/\/+$/, '').toLowerCase();
}

/** そのハッシュが、古い決済まわりのものか */
export function isLegacyHash(hash: string) {
  return LEGACY_HASH.includes(normalize(hash));
}

/** 現在のURLから画面を決める。知らないものは、つくる画面に落とす。 */
export function readRoute(hash = window.location.hash, search = window.location.search): Route {
  const h = normalize(hash);
  if (h === '#/share') return 'share';
  /*
    お礼のページは、送り先が設定されているビルドにしか無い。
    無いビルドで #/tip を開いた人には、つくる画面を出す。
    「あるのに開けない」ではなく「無い」ので、案内も出さない。
  */
  if (TIP_ON && h === '#/tip') return 'tip';
  // 古い応援・お礼のURLは、共有ページとして開く
  if (LEGACY_HASH.includes(h)) return 'share';

  // ハッシュが落ちる経路のための受け口
  if (h === '' || h === '#' || h === '#/') {
    const q = new URLSearchParams(search);
    if (LEGACY_QUERY.some((k) => q.has(k))) return 'share';
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
    古いURLで来た人を、新しいURLに置き換える。

    履歴は「足す」のではなく「置き換える」。足すと、戻るボタンで
    もう無いページへ戻ってしまい、そこからまた送り返されて、
    戻れないループになる。
  */
  useEffect(() => {
    const { origin, pathname, hash, search } = window.location;
    const q = new URLSearchParams(search);
    const stale = isLegacyHash(hash) || LEGACY_QUERY.some((k) => q.has(k));
    if (!stale) return;
    window.history.replaceState(null, '', `${origin}${pathname}${ROUTE_HASH.share}`);
    setRoute('share');
  }, []);

  return route;
}

/** 画面を移る。戻るボタンで戻れるように、履歴には残す。 */
export function navigate(route: Route) {
  window.location.hash = ROUTE_HASH[route];
  window.scrollTo({ top: 0 });
}
