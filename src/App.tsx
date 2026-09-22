import { useCallback, useEffect, useRef, useState } from 'react';
import {
  bitmapToImageData,
  bitmapToPngBlob,
  createCanvas,
  fileToBitmap,
  fitWithin,
  get2d,
  imageDataToCanvas,
} from './lib/image';
import { forgetFrame, hasKeptFrame, keepFrame, loadKeptFrame } from './lib/keep';
import {
  isHapticsOn,
  isSoundOn,
  play,
  setHapticsOn,
  setSoundOn,
  hasHapticsSupport,
} from './lib/sound';
import { autoCropToSubject } from './lib/cutout';
import { findHole, type Hole } from './lib/hole';
import { readRecipe, type Placement, type RecipeLock } from './lib/recipe';
import { CutoutStudio } from './components/CutoutStudio';
import { ComposeStudio } from './components/ComposeStudio';
import { Button, DropZone, Note, Sheet, Toggle } from './components/ui';
import { Sprite } from './components/Sprite';
import { navigate, readFrameId } from './lib/route';
import { SHARE_ON, getFrame } from './lib/frameApi';
import { TipLink } from 'virtual:tip';
import {
  IconArrowRight,
  IconFrame,
  IconHelp,
  IconLock,
  IconPhoto,
  IconSoundOff,
  IconSoundOn,
  IconWand,
  IconX,
} from './components/Icons';

/** 表示・合成に使う写真の上限。これ以上はスマホのメモリに厳しく、見た目も変わらない。 */
const PHOTO_MAX_EDGE = 2048;

type Step = 1 | 2 | 3;

const STEPS: { id: Step; label: string }[] = [
  { id: 1, label: 'アイコン写真' },
  { id: 2, label: '背景をけす' },
  { id: 3, label: '重ねて保存' },
];

export default function App({ active = true }: { active?: boolean }) {
  const [step, setStep] = useState<Step>(1);
  const [photo, setPhoto] = useState<ImageBitmap | null>(null);
  const [photoUrl, setPhotoUrl] = useState<string | null>(null);
  const [frameSource, setFrameSource] = useState<ImageData | null>(null);
  // 自動で切り取る前の画像。「切り取らない」で戻せるように持っておく。
  const [frameFull, setFrameFull] = useState<ImageData | null>(null);
  const [autoCropped, setAutoCropped] = useState(false);
  const [frameResult, setFrameResult] = useState<ImageBitmap | null>(null);
  /*
    フレームの「まん中の穴」。写真をどこに置くかの基準になる。

    フレームは3つの入口（けしたばかり／覚えてあるもの／人からもらったもの）から
    来るので、**出来上がりの絵から探す**。入口ごとに別の道を作らない。
  */
  const [hole, setHole] = useState<Hole | null>(null);
  /*
    配った人が決めた見た目。人からもらったフレームにだけ入っている。
    自分で作ったフレームでは null で、いままでどおり全部さわれる。
  */
  const [lock, setLock] = useState<RecipeLock | null>(null);
  /** 配った人がつけた名前。無いことのほうが多い */
  const [frameName, setFrameName] = useState('');
  /** 配った人が決めたフレームの置き場所。無ければ contain のまま */
  const [framePlacement, setFramePlacement] = useState<Placement | null>(null);
  /*
    もらったフレームの**元のバイト列**。

    覚えておくときに、これをそのまま置く。絵から作り直すと、
    置きかたを書いてあるところ（tEXt）が落ちて、**次に開いたときだけ
    そろわなくなる**。しかも画面は何も変わらないので気づけない。
    受け取ったものは、受け取ったまま置く。
  */
  const [frameBytes, setFrameBytes] = useState<Blob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [help, setHelp] = useState(false);
  const [sound, setSound] = useState(isSoundOn);
  const [haptics, setHaptics] = useState(isHapticsOn);
  /*
    覚えたフレームまわり。

    hasKept は「覚えたものが1つある」。フレームをえらぶ画面を描くときに要るので、
    localStorage の札を同期で読む（lib/keep.ts）。ここで IndexedDB を開くと、
    まだ使うと決まっていないのに最初の1枚目の表示に非同期の往復が乗る。

    frameKept は「いま持っているフレームが、その覚えたものか」。
    札のほうは有無しか知らないので、新しく切りぬいたフレームを見ているのに
    スイッチが入って見える、という食い違いを防ぐために別に持つ。
  */
  const [hasKept, setHasKept] = useState(hasKeptFrame);
  const [frameKept, setFrameKept] = useState(false);
  /** リンクで配られたフレームを、いま取りにいっている最中か */
  const [fetching, setFetching] = useState(() => SHARE_ON && !!readFrameId());
  /** リンクを押して来たか。もらった人の画面を、どこまで削ぐかの目印 */
  const [fromLink, setFromLink] = useState(false);

  const photoUrlRef = useRef<string | null>(null);

  /*
    初回だけ、使いかたを開いておく（迷わせない）。

    ただし、この画面が表に出ているときだけ。
    つくる画面は、応援ページへ寄り道しても作りかけが消えないように
    隠して残してある。使いかたのシートは body の直下に出るので、
    隠れている側から開くと、応援ページの上にかぶさってしまう。
  */
  useEffect(() => {
    if (!active) return;
    try {
      if (!localStorage.getItem('aeframe.seen')) {
        setHelp(true);
        localStorage.setItem('aeframe.seen', '1');
      }
    } catch {
      /* localStorage が使えない環境では出さない */
    }
  }, [active]);

  useEffect(() => {
    return () => {
      if (photoUrlRef.current) URL.revokeObjectURL(photoUrlRef.current);
    };
  }, []);



  /* ---------------- ファイルの読み込み ---------------- */

  const loadPhoto = useCallback(async (file: File) => {
    setError(null);
    try {
      const bmp = await fileToBitmap(file);
      const fit = fitWithin({ width: bmp.width, height: bmp.height }, PHOTO_MAX_EDGE);
      let final = bmp;
      if (fit.width !== bmp.width) {
        const canvas = createCanvas(fit.width, fit.height);
        const ctx = get2d(canvas);
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(bmp, 0, 0, fit.width, fit.height);
        final = await createImageBitmap(canvas);
        bmp.close?.();
      }
      setPhoto(final);

      if (photoUrlRef.current) URL.revokeObjectURL(photoUrlRef.current);
      const url = URL.createObjectURL(file);
      photoUrlRef.current = url;
      setPhotoUrl(url);
    } catch (e) {
      console.warn(e);
      setError(
        'この画像は読み込めませんでした。JPEG か PNG で保存しなおすか、スクリーンショットを撮って試してください。',
      );
      play('error');
    }
  }, []);

  /**
   * 人からもらったフレーム（ファイルでも、リンクでも）を画面に入れる。
   *
   * 置きかたが焼きこんであるなら、そのフレームは**もう背景がけしてある**。
   * けし直すと配った人の絵が変わるし、通す意味も無い。だから背景けしは飛ばす。
   *
   * `to` は行き先。ファイルで渡された人は写真をもう選んでいるので位置あわせへ、
   * リンクで来た人はまだ選んでいないので写真をえらぶところへ。
   */
  const applyGivenFrame = useCallback(async (blob: Blob, to: Step) => {
    const bmp = await fileToBitmap(blob);
    const recipe = readRecipe(new Uint8Array(await blob.arrayBuffer()));
    setFrameResult(bmp);
    setFrameBytes(recipe ? blob : null);
    setHole(recipe?.hole ?? findHole(bitmapToImageData(bmp)));
    setLock(recipe?.lock ?? null);
    setFramePlacement(recipe?.frame ?? null);
    setFrameName(recipe?.name ?? '');
    setFrameKept(false);
    setFrameSource(null);
    setFrameFull(null);
    setAutoCropped(false);
    play('done');
    setStep(to);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, []);

  /*
    リンクで配られたフレームを、開いた瞬間に取りにいく。

    ── なぜ画面を増やさないのか ──

    受け取る人にとっては「リンクを押したら、もう用意できていた」だけでいい。
    専用の画面を作ると、そこから「つくる画面」へ移る一手が増える。
    増やしたいのは手数ではないので、**つくる画面のまま**フレームだけ先に入れる。

    ── 取れなかったとき ──

    期限が切れている、消された、通信が届かない。どれも起こる。
    そのときは**行き止まりにしない**。理由を日本語で出して、
    ふつうのつくる画面として使えるようにする。フレームは自分で選べばいい。
  */
  useEffect(() => {
    const id = readFrameId();
    if (!SHARE_ON || !id) return;
    let alive = true;
    (async () => {
      try {
        const blob = await getFrame(id);
        if (!alive) return;
        if (!blob) {
          setError(
            'このフレームのリンクは、期限が切れているか、取り消されています。配った人にもう一度たずねてください。',
          );
          play('error');
          return;
        }
        setFromLink(true);
        await applyGivenFrame(blob, 1);
      } catch (e) {
        if (!alive) return;
        console.warn(e);
        setError('フレームを読み込めませんでした。電波のいいところで開きなおしてください。');
        play('error');
      } finally {
        if (alive) setFetching(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [applyGivenFrame]);

  const loadFrame = useCallback(async (file: File) => {
    setError(null);
    try {
      /*
        人からもらったフレームかどうかを、先に見る。

        置きかたが焼きこんであるなら、そのフレームは**もう背景がけしてある**。
        もう一度けしにかける意味が無いどころか、けし直すと配った人の絵が変わる。
        だから背景けしの画面を通さず、そのまま位置あわせへ送る。
        受け取った人にとっては、工程が3つから2つに減る。
      */
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (readRecipe(bytes)) {
        // 写真をまだ選んでいない人（配りたいだけで来た人）は、位置あわせに行っても何もできない
        await applyGivenFrame(file, photo ? 3 : 1);
        return;
      }

      const bmp = await fileToBitmap(file);
      const full = bitmapToImageData(bmp);
      bmp.close?.();
      /*
        TikTok は透過を持てないので、フレームは動画・画像として配信され、
        受け取る側はスクショで持ってくる。そこには時刻やキャプション、
        右側のボタン列まで写り込んでいる。先にフレームだけを切り出しておく。
      */
      const { data, cropped } = autoCropToSubject(full);
      setFrameFull(full);
      setFrameSource(data);
      setAutoCropped(cropped);
    } catch (e) {
      console.warn(e);
      setError(
        'このフレーム画像は読み込めませんでした。JPEG か PNG で保存しなおして試してください。',
      );
      play('error');
    }
  }, [applyGivenFrame, photo]);

  const handleCutoutDone = useCallback(async (result: ImageData) => {
    const bmp = await createImageBitmap(imageDataToCanvas(result));
    setFrameResult(bmp);
    setFrameBytes(null);
    setHole(findHole(result));
    setLock(null);
    setFramePlacement(null);
    setFrameName('');
    // 切りぬいたばかりのものは、まだ覚えていない
    setFrameKept(false);
    setStep(3);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, []);

  /** 覚えたフレームを呼び出して、背景けしを飛ばして位置あわせへ送る。 */
  const useKeptFrame = useCallback(async () => {
    setError(null);
    try {
      const kept = await loadKeptFrame();
      if (!kept) {
        setHasKept(false);
        setError('覚えていたフレームが見つかりませんでした。もう一度えらんでください。');
        play('error');
        return;
      }
      const bmp = await fileToBitmap(kept.blob);
      const keptRecipe = readRecipe(new Uint8Array(await kept.blob.arrayBuffer()));
      setFrameResult(bmp);
      setFrameBytes(keptRecipe ? kept.blob : null);
      setHole(keptRecipe?.hole ?? findHole(bitmapToImageData(bmp)));
      // 置きかたごと覚えてあったなら、それも一緒に戻す
      setLock(keptRecipe?.lock ?? null);
      setFramePlacement(keptRecipe?.frame ?? null);
      setFrameName(keptRecipe?.name ?? '');
      setFrameKept(true);
      /*
        背景けしは通さない。覚えてあるのは**けし終わったあと**のもので、
        通してもやることが無い。工程を1つ飛ばせるのがこの機能の中身なので、
        飛ばさずに画面だけ出すと、覚えた意味がなくなる。
      */
      setFrameSource(null);
      setFrameFull(null);
      setAutoCropped(false);
      play('done');
      setStep(3);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (e) {
      console.warn(e);
      setHasKept(false);
      setError('覚えていたフレームを読み出せませんでした。もう一度えらんでください。');
      play('error');
    }
  }, []);

  /** 覚える／忘れる。押されるまで IndexedDB は開かない。 */
  const changeKeep = useCallback(
    async (next: boolean) => {
      // 押した手ごたえを待たせない。失敗したら戻す。
      setFrameKept(next);
      setHasKept(next);
      play(next ? 'toggleOn' : 'toggleOff');
      try {
        if (next) {
          if (!frameResult) throw new Error('フレームがありません');
          // もらったものは、もらったまま置く（作り直すと置きかたが落ちる）
          await keepFrame(frameBytes ?? (await bitmapToPngBlob(frameResult)));
        } else {
          await forgetFrame();
        }
      } catch (e) {
        console.warn(e);
        setFrameKept(!next);
        setHasKept(hasKeptFrame());
        setError(
          next
            ? 'この端末に覚えておけませんでした。空き容量か、ブラウザの設定（プライベートモードなど）を確かめてください。'
            : '覚えていたフレームを消せませんでした。',
        );
        play('error');
      }
    },
    [frameResult, frameBytes],
  );

  const restart = useCallback(() => {
    setStep(1);
    setFrameSource(null);
    setFrameFull(null);
    setAutoCropped(false);
    setFrameResult(null);
    setFrameBytes(null);
    setHole(null);
    setLock(null);
    setFromLink(false);
    setFramePlacement(null);
    setFrameName('');
    setFrameKept(false);
    setError(null);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, []);

  const goto = (next: Step) => {
    setStep(next);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  /*
    どの工程へ行けるか。

    ── 2つめに写真が要らなくなった経緯 ──

    前は「写真をえらばないと背景けしに行けない」作りだった。重ねる相手が
    要るのだから当然、と思っていた。

    けれど**配りたいだけの人**はアイコンを作らない。枠のフレームを1枚
    こしらえて、みんなに配る。その人にとって写真をえらぶのは要らない作業で、
    しかも選ばないと先へ進めないので、**使わない写真を1枚えらばされていた。**

    フレームは背景をけした時点で出来あがる。出来た場所で渡せるように、
    2つめは写真なしでも入れるようにした。3つめ（重ねる）は、
    重ねる相手が要るので写真が要る。
  */
  const canGo = (s: Step) =>
    s === 1 ? true : s === 2 ? true : !!photo && !!frameResult;

  return (
    <div className="app">
      <header className="appbar">
        <h1 className="appbar__title">
          <IconFrame size={24} />
          <span>アイコンフレーム メーカー</span>
        </h1>
        <Button
          variant="icon"
          aria-label="使いかた"
          title="使いかた"
          onClick={() => setHelp(true)}
          style={{ boxShadow: 'var(--shadow-sm)' }}
        >
          <IconHelp size={20} />
        </Button>
        <Toggle
          on={sound}
          title={sound ? '音を消す' : '音を出す'}
          icon={sound ? <IconSoundOn size={19} /> : <IconSoundOff size={19} />}
          onChange={(next) => {
            setSoundOn(next);
            setSound(next);
          }}
        />
      </header>

      <nav className="steps" aria-label="手順">
        {STEPS.map((s) => (
          <button
            key={s.id}
            type="button"
            className="steps__item"
            data-state={step === s.id ? 'current' : step > s.id ? 'done' : 'todo'}
            disabled={!canGo(s.id)}
            aria-current={step === s.id ? 'step' : undefined}
            onClick={() => {
              if (!canGo(s.id) || s.id === step) return;
              play('tap');
              goto(s.id);
            }}
          >
            <span className="steps__dot">{s.id}</span>
            <span className="steps__label">{s.label}</span>
          </button>
        ))}
      </nav>

      {error && (
        <div style={{ marginBottom: 14 }}>
          <Note tone="warn">{error}</Note>
        </div>
      )}

      {/* ---------------- ステップ1 ---------------- */}
      {step === 1 && (
        <div className="card">
          <div className="card__head">
            <span className="card__num">1</span>
            <h2 className="card__title">アイコンにする写真をえらぶ</h2>
          </div>
          <p className="card__hint">
            いまのアイコンや、使いたい自撮り・イラストを選んでください。 うしろに敷く写真です。
          </p>

          {/*
            リンクで来た人へ。

            **押すところは増やさない。** フレームはもう入っているので、
            この人がやることは写真をえらぶことだけ。
            そう言い切ってしまうほうが、選択肢を出すより迷わない。
          */}
          {fetching && (
            <Note>
              <span>フレームを読み込んでいます…</span>
            </Note>
          )}
          {!fetching && frameResult && !photo && (
            <Note tone="ok">
              <span>
                <b>{frameName ? `「${frameName}」が用意できました。` : 'フレームが用意できました。'}</b>
                <br />
                あとは<b>写真をえらぶだけ</b>です。背景をけす手間はありません。
              </span>
            </Note>
          )}

          {/*
            配りたいだけの人のための入口。

            この人はアイコンを作らない。枠のフレームを1枚こしらえて、みんなに配る。
            それなのに、写真をえらばないと背景けしの画面へ進めなかったので、
            **使わない写真を1枚えらばされていた。**

            押しどころにはしない。ほとんどの人は写真をえらびに来ているので、
            強調色は上の「写真をえらぶ」に残す。
          */}
          {!photo && !frameResult && (
            <>
              <div className="spacer" />
              <Button variant="ghost" onClick={() => goto(2)} sound="tap">
                <IconFrame size={17} />
                写真はあとで。フレームだけ作って配る
              </Button>
              <p className="field__note">
                自分のアイコンは作らず、<b>フレームを配りたいだけ</b>のときはこちら。
                背景をけしたら、その場で渡せます。
              </p>
            </>
          )}

          {photo && photoUrl ? (
            <div className="stack">
              <div className="preview">
                <img src={photoUrl} alt="えらんだ写真" />
                <span className="preview__badge">この写真でOK？</span>
              </div>
              {/*
                フレームが出来ているなら、背景けしを通さずに位置あわせへ送る。

                「同じフレームで、写真だけ変える」はいちばん自然な次の行動で、
                そのときフレームはもう出来ている。それなのにステップ2へ戻すと、
                やることが何も無い画面を1枚はさんで「これでOK」を押させることになる。
                通す意味が無い画面は通さない。

                フレームのほうを変えたいときは、上のステップの丸か、
                位置あわせの「背景けしにもどる」から行ける。
              */}
              <Button variant="primary" onClick={() => goto(frameResult ? 3 : 2)}>
                つぎへ：{frameResult ? '位置をあわせる' : 'フレームをえらぶ'}
                <IconArrowRight size={20} />
              </Button>
              <DropZone
                title="べつの写真にする"
                sub="タップして選びなおせます"
                icon={<IconPhoto size={26} />}
                onFile={loadPhoto}
              />
            </div>
          ) : (
            <div className="stack">
              <DropZone
                title="写真をえらぶ"
                sub="タップして選ぶ／ここにドラッグ／貼り付け（Ctrl+V）でもOK"
                icon={<IconPhoto size={34} />}
                onFile={loadPhoto}
              />
              {/*
                まだ何も選んでいないとき、ここは画面でいちばん空いている場所。
                写真が入ったら消えるので、作業の邪魔にならない。
              */}
              <p className="sprite-line">
                <Sprite name="empty" size={72} />
                <span>写真をえらぶと、ここから始まります</span>
              </p>
            </div>
          )}
        </div>
      )}

      {/* ---------------- ステップ2 ---------------- */}
      {/*
        背景けしの画面は、ステップ3へ進んでも「隠すだけ」で外さない。
        取り外すと手描きの修正やしきい値が消え、戻ってきたときにやり直しになる。
      */}
      {frameSource && (
        <div style={step === 2 ? undefined : { display: 'none' }}>
          <CutoutStudio
            source={frameSource}
            notice={
              autoCropped ? (
                <Note>
                  スクショのまわり（時刻・ボタン・キャプションなど）を自動で切り取りました。
                  <div style={{ marginTop: 8 }}>
                    <Button
                      variant="sm"
                      sound="back"
                      onClick={() => {
                        if (!frameFull) return;
                        setFrameSource(frameFull);
                        setAutoCropped(false);
                      }}
                    >
                      切り取らずに全部つかう
                    </Button>
                  </div>
                </Note>
              ) : null
            }
            onDone={handleCutoutDone}
            onBack={() => {
              setFrameSource(null);
              setFrameFull(null);
              setAutoCropped(false);
            }}
          />
        </div>
      )}

      {step === 2 && !frameSource && (
        <div className="card">
          <div className="card__head">
            <span className="card__num">2</span>
            <h2 className="card__title">フレームの画像をえらぶ</h2>
          </div>
          <p className="card__hint">
            重ねたいフレームを選ぶと、背景は<b>自動でとうめい</b>になります。
            白い背景のままの画像でも、<b>スクリーンショットのままでも</b>大丈夫です。
          </p>
          <DropZone
            title="フレームをえらぶ"
            sub="スクショでもOK。まわりの余計なものは自動で切り取ります"
            icon={<IconFrame size={34} />}
            onFile={loadFrame}
          />

          {/*
            覚えたフレームの入口は、ここ1か所だけにしてある。

            ステップ1にも置けるが、置くと「写真をえらぶ」画面に
            フレームの話が混ざる。えらぶ場所は、えらぶ画面にある。
          */}
          {hasKept && (
            <div className="kept">
              <Button variant="ghost" onClick={useKeptFrame}>
                <IconFrame size={17} />
                前に覚えたフレームをつかう
              </Button>
              <p className="kept__note">背景けしは終わっているので、そのまま重ねられます。</p>
            </div>
          )}

          <div className="spacer" />
          <Note>
            <IconWand size={16} /> すでに背景がとうめいなPNGなら、そのまま次に進めます。
          </Note>
        </div>
      )}

      {/* ---------------- ステップ3 ---------------- */}
      {/* こちらも同じ理由で、合わせた位置を保つために外さない */}
      {photo && frameResult && (
        <div style={step === 3 ? undefined : { display: 'none' }}>
          <ComposeStudio
            photo={photo}
            frame={frameResult}
            hole={hole}
            lock={lock}
            framePlacement={framePlacement}
            fromLink={fromLink}
            frameName={frameName}
            active={step === 3}
            onBack={() => goto(2)}
            onChangePhoto={() => goto(1)}
            onRestart={restart}
            kept={frameKept}
            onKeepChange={changeKeep}
          />
        </div>
      )}

      <div className="footer">
        <p>
          <IconLock size={14} /> あなたの写真はこの端末の中だけで処理されます。どこにも送信されません。
        </p>
        {/*
          ここには応援ページへの静かな入口があった。
          決済を外したので、行き先は「知らせるだけ」のページになっている。
          お金の話はしないが、知ってもらえると助かるのは変わらないので残す。
        */}
        <button type="button" className="link-quiet" onClick={() => navigate('share')}>
          このツールを人に知らせる
        </button>
        {/*
          お礼の入口。中身は virtual:tip の向こうにある。

          ── なぜ文言をここに書かないのか ──

          はじめ、ここに {TIP_ON && <button>作った人にお礼を送る</button>} と書いた。
          送り先が空でも押せないだけで、**文字列は配られる JS にそのまま残っていた**。
          前回 Stripe の審査で踏んだ穴と、まったく同じ形。

          ページだけを差し替えても、呼ぶ側に文言が残っていては同じこと。
          出したくないものは、リンクの1行まで全部あちら側に置く。
        */}
        <TipLink />
      </div>

      {help && active && (
        <Sheet onClose={() => setHelp(false)}>
          <div className="card__head" style={{ marginBottom: 10 }}>
            <h2 className="card__title" style={{ flex: 1 }}>
              つかいかた（3ステップ）
            </h2>
            <Button variant="icon" aria-label="とじる" onClick={() => setHelp(false)}>
              <IconX size={20} />
            </Button>
          </div>
          {/* 説明を読ませる前に、案内役がひとこと。ここは他に見るものが無い */}
          <p className="sprite-line sprite-line--lead">
            <Sprite name="help" size={80} />
            <span>3つだけです。だいたい1分で終わります。</span>
          </p>
          <ol className="howto">
            <li>
              <span className="howto__num">1</span>
              <span className="howto__text">
                <b>アイコンにする写真をえらぶ</b>
                <span>いま使っているアイコンや、自撮り・イラストでOKです。</span>
              </span>
            </li>
            <li>
              <span className="howto__num">2</span>
              <span className="howto__text">
                <b>フレームをえらぶ</b>
                <span>
                  <b>スクリーンショットのままでOK。</b>
                  まわりに写った時刻やボタンは自動で切り取り、背景もとうめいにします。
                  うまくいかないときだけ「うまく消えないときは」を開いてください。
                </span>
              </span>
            </li>
            <li>
              <span className="howto__num">3</span>
              <span className="howto__text">
                <b>位置をあわせて保存</b>
                <span>指1本でうごかす、指2本で大きさ・かたむき。最後に「ほぞん」を押します。</span>
              </span>
            </li>
          </ol>

          <div className="stack">
            <Note>
              <IconLock size={15} />{' '}
              あなたの写真はインターネットに送られません。すべてこの端末の中で処理します。
            </Note>

            <div>
              <p style={{ fontWeight: 700, fontSize: '0.9rem', marginBottom: 8 }}>音と振動</p>
              <div className="stack">
                <Toggle
                  on={sound}
                  onChange={(next) => {
                    setSoundOn(next);
                    setSound(next);
                  }}
                  icon={sound ? <IconSoundOn size={19} /> : <IconSoundOff size={19} />}
                  label="操作の音を鳴らす"
                />
                {hasHapticsSupport() && (
                  <Toggle
                    on={haptics}
                    onChange={(next) => {
                      setHapticsOn(next);
                      setHaptics(next);
                      play(next ? 'toggleOn' : 'toggleOff');
                    }}
                    label="操作のふるえ（バイブ）"
                  />
                )}
              </div>
            </div>

            <Button variant="primary" onClick={() => setHelp(false)}>
              はじめる
            </Button>
          </div>
        </Sheet>
      )}
    </div>
  );
}
