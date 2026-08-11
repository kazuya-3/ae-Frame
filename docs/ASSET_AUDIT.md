# ae-Frame Asset Audit

初回調査: 2026-08-11（コミット `b1898d2`）
**Sprint 1 実施後に更新: 2026-08-11**

この文書は**推測ではなく実測**でできています。根拠にした手順は各項に書いてあります。
確認したのは `index.html` / `public/**` / `src/**`（tsx・ts・css）/ `manifest.webmanifest` /
`vite.config.ts` / ビルド成果物 `dist/**`、および実ブラウザでの通信ログです。

---

## 1. Summary

### Sprint 1（軽量化・OG・整理）の結果

| | Before | After |
| --- | --- | --- |
| つくるページ 転送量 | 1.11 MB | **1.11 MB**（変化なし） |
| 応援ページ 転送量 | 6.62 MB | **1.42 MB**（−79%） |
| お礼ページ 転送量 | 5.74 MB | **1.53 MB**（−73%） |
| 素材の合計サイズ | 8,278 KB | **594 KB**（−93%） |
| 応援ページの 404 | 4件 | **1件** |
| お礼ページの 404 | 7件 | **2件** |
| 無駄打ちの 404（候補探索） | 3件 | **0件** |
| SNSメタタグ | 0個 | **14個**（og 9 / twitter 4 / canonical） |
| 本番へ配信される未使用ファイル | 2件（1.53MB） | **0件** |

### いま残っていること

| | |
| --- | --- |
| 参照されているのに**存在しない**スロット | **2**（`support-fruit-decoration` / `support-celebration`） |
| Priority S の不足 | **1**（`og-image.png` の実ファイル。タグ側は実装ずみ） |
| 公開を止めるほどの破損 | **なし** |

**結論**: 初回監査で「一番の約束から外れている」と書いた画像の重さは解消した。
残っているのは飾り2枚と OG画像1枚で、**どれも無くてもページは成立する**。

---

## 2. Critical Missing Assets

### S-1. SNSメタタグ一式 — **DONE（Sprint 1 で実装）**

初回監査の時点では `og:` も `twitter:` も**1つも無かった**。
サイト内に「X で伝える」「LINE で送る」を自分で置いておきながら、
貼られたときの見た目を用意していない状態だった。

Sprint 1 で `index.html` に14個を追加ずみ（第6節に内容）。
検証にも12項目を足して、**絶対URLで書けているか**まで機械で見ている
（相対パスでは相手のサーバーが解決できないため、ここが一番間違えやすい）。

### S-2. `og-image.png` の実ファイル — **MISSING（人が用意）**

タグは `https://kazuya-3.github.io/ae-Frame/og-image.png` を指しているが、
**ファイルはまだ無い**。置くまでは、SNSのカードが画像なしで表示される。

| 項目 | 内容 |
| --- | --- |
| 置き場所 | `public/og-image.png` |
| サイズ | 1200×630（比 1.91:1） |
| 形式 | PNG・**透過なし**（SNS側で白/黒地に置かれるので背景は必ず塗る） |

**これだけが Priority S の残件です。**

---

## 3. Asset Inventory

「現在ファイル」は `public/` からの相対。サイズは実測値。

### Web基本素材

| Priority | Status | Asset | Current File | Recommended File | Usage | Size | Action |
| --- | --- | --- | --- | --- | --- | --- | --- |
| S | DONE | SVG favicon | `favicon.svg` | 同左 | `index.html` | 411B / 32×32 viewBox | そのまま |
| S | DONE | Apple Touch Icon | `apple-touch-icon.png` | 同左 | `index.html` | 180×180 / 8KB | そのまま |
| S | DONE | PWAアイコン 192 | `icon-192.png` | 同左 | `manifest.webmanifest` | 192×192 / 9KB | そのまま |
| S | DONE | PWAアイコン 512 | `icon-512.png` | 同左 | manifest（通常＋maskable兼用） | 512×512 / 29KB | maskable専用の余白版が本来は別途必要（B） |
| S | **MISSING** | OG画像 | — | `public/og-image.png` | `og:image` / `twitter:image` | 1200×630 | **新規制作** |
| B | MISSING | favicon.ico | — | `public/favicon.ico` | 古いブラウザ・一部の検索クローラ | 32×32＋16×16 | 任意 |
| C | MISSING | ヘッダーロゴ画像 | — | — | — | — | **不要**（現在 `IconFrame` のSVGで足りている） |
| C | MISSING | フッターロゴ | — | — | — | — | **不要**（フッターにロゴを置いていない） |

**ヘッダー/フッターのロゴは「MISSING」ではなく「不要」**です。
`src/App.tsx:163` と `src/components/SupportChrome.tsx` はどちらも
`<IconFrame size={24} />`（`src/components/Icons.tsx` の線画SVG）＋テキストで組んでおり、
画像ファイルを一切参照していません。線画で統一されたデザインなので、
ここにラスタ画像を持ち込むと、むしろ他のアイコンから浮きます。

### 応援まわりの素材

**Sprint 1 で置き場所が2つに分かれました。**

| 場所 | 中身 | 配信 |
| --- | --- | --- |
| `assets-src/support/` | 元画像（原寸・無加工） | **されない** |
| `public/assets/support/` | 配る用（長辺1200px・webp） | される |

変換は `tools/optimize-assets.mjs`（`node tools/optimize-assets.mjs`）。
この環境には画像ライブラリが無いので、検証で使っている Chromium の
webp エンコーダを借りています。依存は増やしていません。

参照元は `src/components/PageDecor.tsx` の `SUPPORT_ASSETS`。

| Priority | Status | Asset | Current File | Usage | Size | Action |
| --- | --- | --- | --- | --- | --- | --- |
| — | **DONE** | 応援ページ背景 | `support-bg.webp` | `.decor__bg`（z-index 1） | 1200×800 / **27KB**（元 1,568KB） | 済 |
| — | **DONE** | お礼ページ背景 | **画像を使わない** | `.decor__bg`（CSS の radial-gradient） | **0KB** | 監査どおり画像を作らず CSS に |
| — | **DONE** | 応援マスコット | `hedgehog-support.webp` | `.mascot`（z-index 5） | 1200×800 / **137KB**（元 1,974KB）/ とうめい56.9% | 済 |
| A | NEEDS_REVIEW | お礼マスコット | `hedgehog-thanks.webp` | `.mascot`（z-index 5） | 1200×800 / **284KB**（元 2,635KB）/ とうめい55.3% | 重さは解消。ただし**ハリネズミと葡萄が1枚に同居**しているので、単体で作り直したい |
| A | NEEDS_REVIEW | 水・泡の飾り | `support-water-decoration.webp` | `.decor__water`（z-index 2） | 1200×800 / **147KB**（元 2,102KB）/ **とうめい0%** | 重さは解消。**市松模様の焼き込みは残っている**（下記） |
| B | **MISSING** | 葡萄・葉の飾り | — | `.decor__fruit`（z-index 3） | — | **新規制作** |
| B | **MISSING** | 紙吹雪の演出 | — | `.decor__celebration`（z-index 6） | — | **新規制作** |

#### 新しい素材を足すときの手順

1. 元画像を `assets-src/support/` に、指定の名前で置く（拡張子は png / jpg / webp）
2. `node tools/optimize-assets.mjs` を走らせる
3. `public/assets/support/` に webp ができるので、両方をコミットする

`public/` に直接置いても表示はされますが、**縮まないまま配られます**。

#### 市松模様の焼き込みについて（実測）

`support-water-decoration.png` の左上 64×64 に出てくる色を数えた結果:

```
rgb(254,254,254) ×1200    rgb(247,247,247) ×464
```

白と薄灰が交互＝**「透明ですよ」の目印が、絵として塗り込まれている**。
`hedgehog-thanks.png` として最初に上がってきたファイルでも同じことが起きていた
（そちらは透過率0%だったので、透過のある別ファイルへ差し替え済み）。

いまは CSS 側で `filter: brightness(1.08)` → `mix-blend-mode: multiply` と重ねて
見えないようにしている（`src/styles.css` の `.decor > *`）が、**これは応急処置**。
書き出しのときに「背景を含める」を切れば、この処置は要らなくなる。

**Sprint 1 では直していません。** 軽量化しても焼き込みは元のまま残ります
（縮小と変換であって、絵の中身は変えないため）。素材の作り直しが要ります。

### 外部サービス用

| Priority | Status | Asset | 根拠 | Action |
| --- | --- | --- | --- | --- |
| — | DONE | Stripe 商品画像 | Stripe ダッシュボード側で設定済み（引き継ぎ資料に記載） | リポジトリには不要 |
| C | OPTIONAL | X 投稿用画像 | サイトからは参照しない | OG画像を流用できる |
| C | OPTIONAL | TikTok 用画像 | サイトからは参照しない | 動画素材なので別管理 |
| — | — | BOOTH 商品画像 | **現在 BOOTH 連携は存在しない**（コード内に参照なし） | 今回は対象外 |

---

## 4. Broken / Missing References

実ブラウザ（Chromium・390×900）でビルド成果物を開き、通信ログを取った実測値です。

| ページ | 404（Before → After） | 転送量（Before → After） |
| --- | --- | --- |
| つくる（`/`） | なし → **なし** | 1.11 MB → **1.11 MB** |
| 応援（`#/support`） | 4件 → **1件** | 6.62 MB → **1.42 MB** |
| お礼（`#/support/thanks`） | 7件 → **2件** | 5.74 MB → **1.53 MB** |

**(a) 設計どおりの空振り（候補探索）— 0件になりました**

背景の層は URL を1つしか書かないよう直しました。CSS の `background-image` を
カンマで並べると「無ければ次」ではなく**全部取りに行って重ねる**ので、
候補を並べたぶんだけ無駄な通信が出ていたためです。
マスコットだけは `<img>` なので、順に試しても無駄打ちが出ません。

**(b) 本当に無い（スロットごと欠けている）— 残り2つ**

```
support-fruit-decoration.webp    ← 応援ページ・お礼ページの両方で1回ずつ
support-celebration.webp         ← お礼ページのみ
```

**画面は壊れません。** 飾りは CSS の背景として敷いてあるので、
ファイルが無ければ何も起きないだけです。

#### 軽量化の内訳（`node tools/optimize-assets.mjs` の出力）

```
hedgehog-support.png          1536×1024 → 1200×800   1974KB →  137KB  (-93%)  とうめい 56.9%
hedgehog-thanks.png           1536×1024 → 1200×800   2635KB →  284KB  (-89%)  とうめい 55.3%
support-bg.png                1536×1024 → 1200×800   1568KB →   27KB  (-98%)  とうめい 0%
support-water-decoration.png  1536×1024 → 1200×800   2102KB →  147KB  (-93%)  とうめい 0%

合計 8278KB → 594KB  (-93%)
```

長辺1200px・品質0.82。**透過はそのまま保たれています**（56.9% / 55.3%）。
PC（1280px）とスマホ（390px・2倍解像度）の両方で見比べて、**劣化は見て取れません**。
飾りがいちばん大きく出るところでも画面幅ぶん（PCで620px、スマホで430px）なので、
2倍解像度を見込んでも1200pxで足りる、という計算です。

---

## 5. Unused Assets

**Sprint 1 で片づけました。本番へ配信される未使用ファイルは0件です。**

| ファイル | 実測 | 対処 | 結果 |
| --- | --- | --- | --- |
| `hedgehog-thanks-baked-bg.png.unused` | 1.53MB | `assets-src/support/` へ退避 | 配信されなくなった。**消してはいない**（差し替え前の記録として残す） |
| `assets/support/README.md` | 2.5KB | `assets-src/support/` へ移動 | 素材を置く場所のとなりにある形になり、配信されなくなった |
| 元画像4枚 | 8.28MB | `assets-src/support/` へ退避 | 原寸のまま保管。配るのは webp のほう |

削除の前に、参照がゼロであることを確かめています。

```
$ grep -rn "baked-bg\|\.unused" src/ index.html public/ --include=*.ts --include=*.tsx --include=*.css --include=*.html
（1件もヒットせず）
```

`tests/fixtures/*.png`（13枚）は `tests/fixtures.mjs` がその場で描き起こす生成物で、
`.gitignore` 済み・本番へは行きません。**未使用素材ではありません。**

---

## 6. Recommended New Assets

### S｜`og-image.png`

| 項目 | 内容 |
| --- | --- |
| 保存場所 | `public/og-image.png` |
| 用途 | `og:image` / `twitter:image`。X・LINE・Slack・Discord に貼られたときのカード |
| サイズ | **1200×630**（比 1.91:1） |
| 形式 | PNG（透過**不要**。SNS側で白または黒地に置かれるため、**背景は必ず塗る**） |
| PC/Mobile | 共通 |
| alt候補 | （OG画像に alt は不要。`og:image:alt` を使うなら「アイコンフレーム メーカーの紹介画像」） |
| 実画像が必要か | **必要**。SNSのクローラはCSSを実行しないので、SVGやCSSでは代替できない |
| どんな画像か | ツールの結果がひと目で伝わる絵。**左にフレーム前のアイコン写真、右に重ねたあとの完成アイコン**を並べ、中央に矢印。上に「アイコンフレーム メーカー」、下に小さく「スマホだけで、背景けし → 重ねて保存」。既存の紙のような地（`#fbfaf6`）と黒の線画で、サイトと同じ見た目に。 |

### S｜メタタグ — **実装ずみ**

`index.html` に14個を追加しました（画像は `og-image.png` の1枚だけで足ります）。

| タグ | 値 |
| --- | --- |
| `og:type` | `website` |
| `og:site_name` | `ae-Frame` |
| `og:locale` | `ja_JP` |
| `og:title` | ae-Frame｜アイコンフレームを、もっと簡単に。 |
| `og:description` | アイコンフレームの背景を消して、プロフィール写真に重ねて保存。アプリ不要・登録不要で使える無料Webツール。 |
| `og:url` | `https://kazuya-3.github.io/ae-Frame/` |
| `og:image` | `https://kazuya-3.github.io/ae-Frame/og-image.png` |
| `og:image:width` / `height` / `alt` | 1200 / 630 / アイコンフレーム メーカーの紹介画像 |
| `twitter:card` | `summary_large_image` |
| `twitter:title` / `description` / `image` | og と同じ値 |
| `link[rel=canonical]` | `https://kazuya-3.github.io/ae-Frame/` |

**ここだけ絶対URLで書いています。** ほかは相対パス（`./`）で組んでありますが、
`og:image` と `og:url` は読むのが相手のサーバーなので、相対では解決できません。
**公開先を変えるときは、この4か所も一緒に変えてください。**

`<title>` と `meta[name=description]` は**変えていません**。
あちらは検索結果とタブ用、こちらは人に手渡されたときの1行で、役割が違うためです
（内容は矛盾させていません）。

検証にも12項目を足しました（タグの有無、絶対URLか、og と twitter が食い違っていないか）。

### ~~A｜`thanks-bg.webp`~~ — **画像を作らずCSSで解決しました**

初回監査で「CSSだけで十分」と書いたとおりに実装しました。

```css
.decor[data-variant='thanks'] .decor__bg {
  background-image:
    radial-gradient(115% 70% at 50% 0%, var(--accent-wash) 0%, transparent 62%),
    radial-gradient(80% 55% at 100% 100%, var(--ok-wash) 0%, transparent 70%);
}
```

**0KB**。既存の色トークンだけで書いてあるので暗いテーマにも自動で追随し、
どの画面幅でも崩れません。**素材を1枚作らずに済みました。**

### B｜`support-fruit-decoration.png`

| 項目 | 内容 |
| --- | --- |
| 保存場所 | `public/assets/support/support-fruit-decoration.png` |
| 用途 | 左上から入ってくる飾り（z-index 3 / `opacity: 0.38`） |
| サイズ | 1536×1024 程度、**400KB以下** |
| 形式 | PNG（**透過必須**。市松を焼き込まない） |
| どんな画像か | 葡萄の房・葉・蔓を**画面の左上の角に寄せた**構図。中央から右下は空ける。 |

### B｜`support-celebration.png`

| 項目 | 内容 |
| --- | --- |
| 保存場所 | `public/assets/support/support-celebration.png` |
| 用途 | お礼ページの最前面（z-index 6 / `opacity: 0.3` ＋ 中央を抜くマスク） |
| サイズ | 1536×1024 程度、**400KB以下** |
| 形式 | PNG（**透過必須**） |
| どんな画像か | ハート・星・紙吹雪を**上端と左右の縁にだけ**散らす。**中央は完全に空ける**（本文の上に重なるため）。密度は控えめに。 |

### B｜maskable 専用アイコン

いまは `icon-512.png` を通常用と maskable 用で兼用しています（`manifest.webmanifest`）。
Android のホーム画面では外周が丸く切られるため、**余白の少ない絵だと端が欠けます**。
`icon-512-maskable.png`（512×512／絵は中央80%に収める）を別に用意すると確実です。

---

## 7. Background / Visual Recommendation

ページ・セクションごとの判断です。**寂しいからという理由での追加はしていません。**

| 画面 | 判断 | 理由 |
| --- | --- | --- |
| つくる（ステップ1〜3） | **C. 背景なしのほうが良い** | ここは画像を見比べる画面。`body::before` の方眼（`opacity: 0.035`）だけで足りる。透過の結果を目で確かめる場所なので、背景に色があると**判断の邪魔**になる。市松の下じきをテーマに追随させなかったのと同じ理由（引き継ぎ資料 CASE 参照） |
| 応援ページ | **A. 背景画像が必要**（現状のまま） | 「お金の話をする画面」がツールと同じ素っ気なさだと、事務的すぎる。ただし**いまの1.5MBは過剰**。縮小するだけでよい |
| お礼ページ | **B. CSSだけで十分** — **実装ずみ** | `radial-gradient` 2本で書いた。0KB・暗いテーマにも追随。**素材を1枚作らずに済んだ** |
| 応援ページの左上 | **A. 画像**（`support-fruit-decoration`） | 現在ここだけ空いていて、右下に偏って見える |

### CSS / SVG だけで済ませられるもの

- **お礼ページの地** — **Sprint 1 で実装ずみ**（`radial-gradient` 2本 / 0KB）。
  画像1枚（数百KB）を足すより軽く、暗いテーマにも自動で追随します。
- **ヘッダー／フッターのロゴ** — 既存の `IconFrame`（線画SVG）で足りています。
- **紙吹雪の動き** — 静止画＋既存の `celebrate-in` アニメーションで十分。
  `prefers-reduced-motion` の停止も実装済み。

### 「制作の痕跡」を薄く感じさせる案について

ご提案の方向（円弧・ガイドライン・アンカーポイント・制作グリッド）は、
**このプロジェクトの見た目とよく合います**。ただし**新しい画像は要りません。**

- **方眼はすでにあります** — `body::before` が 28px の格子を `opacity: 0.035` で敷いています
  （`src/styles.css:87-98`）。これがまさに「制作グリッド」です
- **円弧・アンカーポイントは SVG で十分** — 数百バイトで書けて、暗いテーマにも追随し、
  拡大しても崩れません。ラスタ画像にする理由がありません
- 応援ページで足すなら、**円弧1本＋アンカー点3〜4個**程度に留めるのが安全です。
  いまは水と果実の飾りが既に入っているので、**足すと過密になります**

**推奨: 今回は追加しない。** 素材の軽量化と OG画像が先です。

---

## 8. Next Actions

Sprint 1 で 1・5 と、2 のうちコード側が終わりました。残りは次のとおりです。

### 済んだこと（Sprint 1）

- ✅ 素材4枚を長辺1200px・webp に（8,278KB → 594KB / −93%）
- ✅ 元画像を `assets-src/support/` へ退避（配信対象外・原寸のまま保管）
- ✅ 未使用ファイルを配信対象から外した（1.53MB）
- ✅ SNSメタタグ14個を実装（絶対URLの検証つき）
- ✅ お礼ページの背景を CSS で実装（素材1枚ぶん不要に）
- ✅ 候補探索の無駄な404を0件に

### 残っていること

1. **【S】`og-image.png`（1200×630・透過なし）を `public/` に置く** —
   タグは実装ずみなので、ファイルを置けばそのまま効きます
2. **【A】`support-water-decoration` を透過で書き出し直す** —
   軽量化しても市松の焼き込みは残っています（縮小と変換であって、絵の中身は変えないため）。
   CSS の応急処置（`brightness` → `multiply`）を外せるようになります
3. **【A】`hedgehog-thanks` をハリネズミ単体で作り直す**（いまは葡萄と同居）
4. **【B】`support-fruit-decoration.webp`** — 応援ページの左上が空いています
5. **【B】`support-celebration.webp`** — お礼ページの演出
6. **【B】`icon-512-maskable.png`** を通常用と分ける
7. **【C】`favicon.ico`**

2〜5 は `assets-src/support/` に原寸を置いて
`node tools/optimize-assets.mjs` を走らせるだけで、配信用の webp ができます。

**公開を止める問題はありません。**
