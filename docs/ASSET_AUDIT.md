# ae-Frame Asset Audit

調査日: 2026-08-11 ／ 対象コミット: `b1898d2`

この文書は**推測ではなく実測**でできています。根拠にした手順は各項に書いてあります。
確認したのは `index.html` / `public/**` / `src/**`（tsx・ts・css）/ `manifest.webmanifest` /
`vite.config.ts` / ビルド成果物 `dist/**`、および実ブラウザでの通信ログです。

---

## 1. Summary

| | |
| --- | --- |
| 参照されているのに**存在しない**スロット | **3**（thanks-bg / support-fruit-decoration / support-celebration） |
| 存在するが**どこからも使われていない** | **2**（`hedgehog-thanks-baked-bg.png.unused` / `README.md`。どちらも本番へ配信されている） |
| Priority S の不足 | **2**（OG画像、SNSメタタグ一式） |
| いちばん重い問題 | **応援ページ 6.62MB / お礼ページ 5.74MB**（実測。スマホ前提のツールとしては重すぎる） |
| 公開を止めるほどの破損 | **なし**（404が出ても、ページは全機能そのまま動く） |

**結論**: 壊れてはいない。ただし「スマホしか持っていない人を前提にする」という
このプロジェクトの一番の約束に対して、**画像の重さだけが明確に外れている**。
ここを直すのが最優先で、OG画像がその次。

---

## 2. Critical Missing Assets

### S-1. OG画像（`og:image`）とSNSメタタグ一式 — **MISSING**

`index.html` を全文検索した結果、**`og:` も `twitter:` も1つも無い**。

```
$ grep -in "og:\|twitter:\|canonical" index.html
（1件もヒットせず）
```

このツールは **TikTok のコメントに URL を貼って配る**ことが唯一の入口で、
さらにサイト内に「X で伝える」「LINE で送る」「シェアする」ボタンを自分で置いている
（`src/components/ShareRow.tsx`）。
**自分でシェアを促しておきながら、シェアされたときの見た目を用意していない**状態。

いま X や LINE に貼ると、画像なし・タイトルだけの素っ気ないカードになる。

### S-2. `canonical` と `og:url` — **MISSING**

ハッシュルーティング（`#/support`）を使っているので、
`#` 付きの URL がそのまま共有されうる。正規URLを明示しておきたい。

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

### 応援まわりの素材（`public/assets/support/`）

参照元は `src/components/PageDecor.tsx:42-48`。
各スロットは `.webp` → `.png` の**候補リスト**になっていて、**どちらか一方があれば足ります**。

| Priority | Status | Asset | Current File | Recommended File | Usage | Size | Action |
| --- | --- | --- | --- | --- | --- | --- | --- |
| A | **REPLACE** | 応援ページ背景 | `support-bg.png` | `support-bg.webp` | `.decor__bg`（z-index 1） | 1536×1024 / **1.53MB** | 縮小して webp 化 |
| A | **MISSING** | お礼ページ背景 | — | `thanks-bg.webp` | `.decor__bg`（z-index 1） | 1536×1024 目安 | **新規制作** |
| A | NEEDS_REVIEW | 応援マスコット | `hedgehog-support.png` | 同名で軽量化 | `.mascot`（z-index 5） | 1536×1024 / **1.93MB** / とうめい57% | 透過は正常。重さのみ問題 |
| A | **REPLACE** | お礼マスコット | `hedgehog-thanks.png` | 同名で作り直し | `.mascot`（z-index 5） | 1536×1024 / **2.57MB** / とうめい55.6% | 透過は正常だが**ハリネズミと葡萄が1枚に同居**。単体にしたい |
| A | **REPLACE** | 水・泡の飾り | `support-water-decoration.png` | 同名で作り直し | `.decor__water`（z-index 2） | 1536×1024 / **2.05MB** / **とうめい0%** | **市松模様が焼き込まれている**（下記） |
| B | **MISSING** | 葡萄・葉の飾り | — | `support-fruit-decoration.png` | `.decor__fruit`（z-index 3） | 1536×1024 目安 | **新規制作** |
| B | **MISSING** | 紙吹雪の演出 | — | `support-celebration.png` | `.decor__celebration`（z-index 6） | 1536×1024 目安 | **新規制作** |
| — | **UNUSED** | 差し替え前のマスコット | `hedgehog-thanks-baked-bg.png.unused` | — | どこからも参照なし | **1.53MB** | **リポジトリから削除**（下記） |
| — | **UNUSED** | 素材の説明書 | `assets/support/README.md` | `docs/` へ移すか除外 | 人間向け。ブラウザからは読まれない | 2.5KB | 本番配信から外す |

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

| ページ | 404 | 読み込めた画像 | 転送量 |
| --- | --- | --- | --- |
| つくる（`/`） | **なし** | favicon.svg | **1.11 MB** |
| 応援（`#/support`） | 4件 | hedgehog-support.png / support-bg.png / support-water-decoration.png / favicon.svg | **6.62 MB** |
| お礼（`#/support/thanks`） | 7件 | hedgehog-thanks.png / support-water-decoration.png / favicon.svg | **5.74 MB** |

404 の内訳は2種類に分かれます。

**(a) 設計どおりの空振り**（候補リストの片方。害はないが通信は発生する）

```
support-bg.webp / support-water-decoration.webp
```

**(b) 本当に無い**（スロットごと欠けている）

```
thanks-bg.webp   thanks-bg.png
support-fruit-decoration.png   support-fruit-decoration.webp
support-celebration.png        support-celebration.webp
```

いずれも**画面は壊れません**。飾りは CSS の背景として敷いてあるので、
ファイルが無ければ何も起きないだけです（`src/components/PageDecor.tsx` 冒頭のコメント参照）。
マスコットだけ `<img>` で、候補を順に試して全部だめなら枠ごと畳みます。

> **転送量のほうが本当の問題です。**
> つくる画面 1.11MB に対して、応援ページは **6倍**。
> 素材5枚がどれも 1.5〜2.6MB あるためで、長辺 1200px 程度に縮めれば
> 見た目をほとんど変えずに **1MB 未満**まで落ちます。

---

## 5. Unused Assets

| ファイル | 実測 | なぜ不要か | 対処 |
| --- | --- | --- | --- |
| `public/assets/support/hedgehog-thanks-baked-bg.png.unused` | 1.53MB | 市松が焼き込まれていたため差し替え済み。コード内に参照ゼロ（`grep -rn` 済み）。**それでも `public/` にあるので `dist/` へ丸ごと配信されている** | リポジトリから削除（履歴には残る） |
| `public/assets/support/README.md` | 2.5KB | 人間向けの説明書。ブラウザからは読まれないが、`public/` にあるため本番へ配信される | `docs/` へ移すか、配信から除外 |

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

### S｜メタタグ（画像ではなくコードの追加）

`index.html` に以下を足すだけ。**画像制作は og-image.png の1枚で足ります。**

```html
<meta property="og:type" content="website" />
<meta property="og:title" content="アイコンフレーム メーカー" />
<meta property="og:description" content="フレーム画像の背景を自動でとうめいにして、そのままアイコン写真に重ねられる無料ツール。" />
<meta property="og:image" content="https://kazuya-3.github.io/ae-Frame/og-image.png" />
<meta property="og:url" content="https://kazuya-3.github.io/ae-Frame/" />
<meta name="twitter:card" content="summary_large_image" />
<link rel="canonical" href="https://kazuya-3.github.io/ae-Frame/" />
```

> `og:image` は**絶対URLでないと読まれません**。相対パス（`./`）では効きません。
> ここだけは `vite.config.ts` の相対ベースの方針から外れます。

### A｜`thanks-bg.webp`

| 項目 | 内容 |
| --- | --- |
| 保存場所 | `public/assets/support/thanks-bg.webp` |
| 用途 | お礼ページ全体の地（`.decor__bg` / z-index 1 / `opacity: 0.5` ＋ 中央を抜くマスク） |
| サイズ | 1536×1024 程度、**500KB以下** |
| 形式 | WEBP。透過不要（背景として敷くので） |
| 実画像が必要か | **どちらでもよい**。→ 第7節参照 |
| どんな画像か | 応援ページの水色より少し温かい、淡いピンク〜クリームの地。**中央は必ず空ける**（本文が載るため）。 |

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
| お礼ページ | **B. CSSだけで十分**（当面） | いまは `thanks-bg` が無いまま運用できている。ここは**紙吹雪（celebration）のほうが効く**ので、背景は後回しでよい |
| 応援ページの左上 | **A. 画像**（`support-fruit-decoration`） | 現在ここだけ空いていて、右下に偏って見える |

### CSS / SVG だけで済ませられるもの

- **お礼ページの地** — 既存トークンだけで書けます:
  ```css
  background: radial-gradient(120% 80% at 50% 0%, var(--accent-wash) 0%, transparent 60%);
  ```
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

優先順に。上2つが公開前にやる価値のあるもので、それ以外は仕上げです。

1. **【S】素材5枚を軽量化する** — 長辺1200px・webp。応援ページ 6.62MB → 1MB未満が目安。
   スマホしか持っていない人が前提のツールなので、ここがいちばん効きます
2. **【S】`og-image.png`（1200×630）を1枚作り、`index.html` にメタタグを足す** —
   自分でシェアボタンを置いているのに、シェアされたときの絵が無い状態です
3. **【A】`support-water-decoration.png` を透過で書き出し直す** —
   市松の焼き込みを CSS で打ち消している応急処置を外せます
4. **【A】`hedgehog-thanks.png` をハリネズミ単体で作り直す**（いまは葡萄と同居）
5. **【A】`hedgehog-thanks-baked-bg.png.unused` を削除、`README.md` を配信から外す** — 合計1.53MBの無駄
6. **【B】`support-fruit-decoration.png` / `support-celebration.png`** を作る
7. **【B】`icon-512-maskable.png`** を分ける
8. **【C】`favicon.ico`**

**公開を止める問題はありません。** 1〜2は「公開してから直す」でも壊れませんが、
**配る前にやったほうが体験がはっきり良くなる**ものです。
