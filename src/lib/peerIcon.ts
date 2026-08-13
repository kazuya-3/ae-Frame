/**
 * 隣に並べる、見本のアイコン。
 *
 * ── なぜ無地の丸ではだめだったか ──
 *
 * はじめ、隣は灰色の丸にしていた。「他の人のアイコン」を意味だけで置いた形。
 * これが弱かった。丸が3つ並んでいても、目には「余白に点がある」としか映らず、
 * 肝心の「この中で自分のフレームは埋もれるか、浮きすぎるか」が判定できない。
 *
 * 実際のコメント欄で隣に並ぶのは、無地の丸ではない。
 * 顔だったり、絵だったり、とにかく何かが描いてあって、色がついている。
 * 比べる相手が無地だと、自分のアイコンは必ず勝ってしまう。
 * それでは見比べる意味がない。
 *
 *
 * ── なぜ描くのか（画像を置かないのか） ──
 *
 * 見本を画像で置くと、つくる画面がその枚数ぶん重くなる。
 * この帯はステップ3を開いた人全員に出るので、出るまで取りに行かない
 * （ひょっこり出るハリネズミ）の逃げかたが使えない。
 *
 * 40px の絵に必要なのは、輪郭と色と、何かが描いてあるという感じだけ。
 * それならキャンバスで足りる。素材は1枚も増えない。
 *
 *
 * ── 縁を付けない ──
 *
 * 見本には飾りの輪を描かない。輪を持っているのは自分のアイコンだけ、
 * という状態でなければ「フレームがあると目立つか」が比べられない。
 * 地とアイコンの境目を示す髪の毛ほどの線は CSS 側で足している（自分と同じ1本）。
 */

/** 見本1つぶんの見た目。人が違えば色も違う、という当たり前を作る */
export type PeerLook = {
  /** アイコンの地の色 */
  bg: string;
  /** とげの色 */
  quill: string;
  /** 顔とおなかの色 */
  skin: string;
  /** その子だけの目印。無しでもよい */
  mark?: 'leaf' | 'blush';
  markColor?: string;
};

/*
  並べる見本。

  彩度は抑える。隣が派手だと、こんどは自分のアイコンが負けて見えて、
  やはり正しく比べられなくなる。地の色だけで人の違いを出し、
  絵そのものは同じ子の描き分けにとどめる。

  地はどれも明るい色にしてある。この帯は地を「あかるい／くらい」で
  切り替えるので、どちらの地でも見本が消えないほうがよい。
*/
export const PEER_LOOKS: PeerLook[] = [
  { bg: '#f4dcbe', quill: '#8b5e3c', skin: '#f8eede' },
  { bg: '#d6e6da', quill: '#5f7a6b', skin: '#f4f0e6', mark: 'leaf', markColor: '#7ba05b' },
  { bg: '#e3ddf2', quill: '#6f6291', skin: '#f3ede3', mark: 'blush', markColor: '#e79aae' },
];

/**
 * 見本のアイコンを1つ描く。
 *
 * @param g    描き先
 * @param size 画素の一辺（端末の解像度ぶん。CSS の px ではない）
 * @param look どの子か
 */
export function drawPeerIcon(g: CanvasRenderingContext2D, size: number, look: PeerLook) {
  /* すべて 0〜1 の比で書いて、最後に大きさを掛ける。どの解像度でも同じ絵になる */
  const u = (v: number) => v * size;
  const dot = (x: number, y: number, r: number, fill: string) => {
    g.fillStyle = fill;
    g.beginPath();
    g.arc(u(x), u(y), u(r), 0, Math.PI * 2);
    g.fill();
  };

  g.clearRect(0, 0, size, size);

  /* 地。SNS のアイコンは必ず丸く切られるので、はじめから丸で塗る */
  g.save();
  g.beginPath();
  g.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
  g.clip();
  g.fillStyle = look.bg;
  g.fillRect(0, 0, size, size);

  /*
    とげ。

    上半分だけをぎざぎざにして、おなか側はなめらかに閉じる。
    全周をとげにすると、40px では毬（まり）にしか見えなくなり、
    どちらが前か分からなくなる。
  */
  const cx = u(0.45);
  const cy = u(0.6);
  const rx = u(0.29);
  const ry = u(0.245);
  const tip = u(0.075);
  const spikes = 8;

  g.fillStyle = look.quill;
  g.beginPath();
  g.moveTo(cx + rx * Math.cos(Math.PI), cy + ry * Math.sin(Math.PI));
  for (let i = 0; i < spikes; i++) {
    const a0 = Math.PI + (Math.PI * i) / spikes;
    const a1 = Math.PI + (Math.PI * (i + 1)) / spikes;
    const mid = (a0 + a1) / 2;
    g.lineTo(cx + (rx + tip) * Math.cos(mid), cy + (ry + tip) * Math.sin(mid));
    g.lineTo(cx + rx * Math.cos(a1), cy + ry * Math.sin(a1));
  }
  /* おなか側は、そのまま楕円で戻す */
  g.ellipse(cx, cy, rx, ry, 0, 0, Math.PI);
  g.closePath();
  g.fill();

  /* 足。地面に着いている感じが出て、丸ではなく生きものに見える */
  g.fillStyle = look.skin;
  for (const fx of [0.33, 0.58]) {
    g.beginPath();
    g.ellipse(u(fx), u(0.825), u(0.055), u(0.032), 0, 0, Math.PI * 2);
    g.fill();
  }

  /* 耳。とげの下からのぞかせる */
  dot(0.565, 0.475, 0.052, look.quill);

  /*
    顔。右へ向いた、とがった鼻先。

    まる顔にすると猫にも鼠にも見える。とがらせるのが、この子である決め手。
  */
  g.fillStyle = look.skin;
  g.beginPath();
  g.moveTo(u(0.53), u(0.495));
  g.quadraticCurveTo(u(0.88), u(0.55), u(0.895), u(0.655));
  g.quadraticCurveTo(u(0.885), u(0.755), u(0.6), u(0.76));
  g.quadraticCurveTo(u(0.5), u(0.63), u(0.53), u(0.495));
  g.closePath();
  g.fill();

  if (look.mark === 'blush') dot(0.655, 0.7, 0.045, look.markColor!);

  /* 目と鼻。ここだけ濃くする。40px でも「顔がある」と分かるのはこの2点のおかげ */
  dot(0.675, 0.6, 0.037, 'rgba(28,24,22,0.78)');
  dot(0.868, 0.655, 0.038, 'rgba(28,24,22,0.85)');

  /* 背中の葉っぱ。その子だけの目印 */
  if (look.mark === 'leaf') {
    g.fillStyle = look.markColor!;
    g.beginPath();
    g.moveTo(u(0.2), u(0.36));
    g.quadraticCurveTo(u(0.3), u(0.2), u(0.4), u(0.25));
    g.quadraticCurveTo(u(0.31), u(0.36), u(0.2), u(0.36));
    g.closePath();
    g.fill();
  }

  g.restore();
}
