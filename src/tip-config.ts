/**
 * ===========================================================================
 *  応援（チップ）の設定  ——  ここだけ書き換えれば有効になります
 * ===========================================================================
 *
 * このツールは無料で配る前提です。それでも「気持ちだけ渡したい」という人が
 * いるので、その受け皿を用意しています。
 *
 * 下の URL が空のあいだは、応援の案内は画面のどこにも出ません。
 * つまり、設定しなければ今までどおりのツールのままです。
 *
 *
 * ── なぜ Stripe の「支払いリンク（Payment Links）」なのか ──
 *
 * このツールはサーバーを持たない静的サイト（GitHub Pages）です。
 * ふつうの Stripe 決済はサーバー側の処理が要りますが、支払いリンクなら
 * Stripe が用意した決済ページに飛ばすだけなので、サーバーが要りません。
 *
 * カード番号はこのサイトを一切通りません。Stripe の画面で直接入力されます。
 * こちらは何も預からないので、いちばん安全で、いちばん手間がかからない形です。
 *
 * ここに並ぶ URL は「決済ページの入口」で、秘密の情報ではありません。
 * 押してもらうためのものなので、公開リポジトリに入っていて問題ありません。
 * 逆に、Stripe の**シークレットキーをここに書いてはいけません**。
 * このファイルは、そのまま利用者のブラウザに配られます。
 *
 *
 * ── 作りかた（10分ほど） ──
 *
 * 1. https://dashboard.stripe.com/register でアカウントを作る
 *    （日本の個人でも作れます。本人確認と振込先の口座が要ります）
 *
 * 2. 「商品」→「商品を追加」で、応援用の商品を1つ作る
 *    名前の例：「アイコンフレーム メーカーへの応援」
 *
 * 3. 金額ごとに「支払いリンク」を作る
 *    ダッシュボード左の「支払いリンク」→「新規作成」→ 上で作った商品を選ぶ
 *
 * 4. 金額を相手に決めてもらう用のリンクも1つ作る
 *    価格を作るときに「顧客が金額を指定できるようにする」を選ぶと作れます
 *
 * 5. できた URL（https://buy.stripe.com/... の形）を下に貼る
 *
 * 6. 各リンクの「支払い後」の遷移先に、このツールの完了ページを設定する
 *    → 公開URL + `#/support/thanks`
 *    （例：https://kazuya-3.github.io/ae-Frame/#/support/thanks）
 *    ここは Stripe のダッシュボード側の設定なので、コードからは変えられません。
 *
 *
 * ── 注意 ──
 *
 * ・Stripe の手数料は、日本のカードで 3.6%（2024年時点。最新は Stripe の料金表で確認）。
 *   300円の応援なら手元に残るのは 289円ほどです。少額を並べすぎると手数料負けします。
 * ・受け取ったお金は所得になります。金額によっては確定申告が要ります。
 * ・「対価のない任意の支援」として受け取る形なので、見返り（特典）を約束しないこと。
 *   約束すると商取引になり、特定商取引法の表示義務などが発生します。
 */

export type TipOption = {
  /** 見分けるための ID。検証と選択状態に使う */
  id: string;
  /** カードの見出し。「300円」など */
  label: string;
  /** その下の短い名前。「ちょこっと応援」など */
  title: string;
  /** さらに下の一言。押す理由を短く */
  note: string;
  /** Stripe の支払いリンク（https://buy.stripe.com/... ） */
  url: string;
  /** 「おすすめ」を付けるか。1つだけ */
  recommended?: boolean;
};

/**
 * 金額の決まった応援。3つくらいが選びやすい。
 * URL を空のままにしたものは表示されません。
 */
export const TIP_OPTIONS: TipOption[] = [
  {
    id: 'p300',
    label: '300円',
    title: 'ちょこっと応援',
    note: '気軽なきもちで',
    url: 'https://buy.stripe.com/bJe7sE4b32r1d3EfYW3VC00',
  },
  {
    id: 'p500',
    label: '500円',
    title: 'もうひと押し応援',
    note: 'いちばん選ばれています',
    url: 'https://buy.stripe.com/00w7sEazrd5F0gSaEC3VC01',
    recommended: true,
  },
  {
    id: 'p1000',
    label: '1,000円',
    title: 'しっかり応援',
    note: '制作の助けになります',
    url: 'https://buy.stripe.com/cNidR2gXP4z90gSbIG3VC02',
  },
];

/** 金額を自分で決めたい人むけ。空なら「自由入力」カードは出ません。 */
export const TIP_CUSTOM_URL = 'https://buy.stripe.com/dRm00cbDv0iTe7I5ki3VC03';

/** 自由入力のカードも、ほかと同じ形で扱えるようにしておく */
export const CUSTOM_OPTION: TipOption = {
  id: 'custom',
  label: '自由入力',
  title: '好きな金額で応援',
  note: '金額は次の画面で',
  url: TIP_CUSTOM_URL,
};

/** ひとつでも設定されていれば、応援の案内を出す。 */
export function hasTipLinks() {
  return TIP_OPTIONS.some((o) => o.url.trim() !== '') || TIP_CUSTOM_URL.trim() !== '';
}

/** 実際に表示する選択肢だけを返す。 */
export function activeTipOptions() {
  return TIP_OPTIONS.filter((o) => o.url.trim() !== '');
}

/** 自由入力を含めた、応援ページに並べるカード。 */
export function supportPlans(): TipOption[] {
  const plans = activeTipOptions();
  return TIP_CUSTOM_URL.trim() ? [...plans, CUSTOM_OPTION] : plans;
}

/** 最初から選んでおくもの。「おすすめ」があればそれ、無ければ先頭。 */
export function defaultPlanId(): string | null {
  const plans = supportPlans();
  return plans.find((p) => p.recommended)?.id ?? plans[0]?.id ?? null;
}
