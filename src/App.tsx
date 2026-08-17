import { useCallback, useEffect, useRef, useState } from 'react';
import {
  bitmapToImageData,
  createCanvas,
  fileToBitmap,
  fitWithin,
  get2d,
  imageDataToCanvas,
} from './lib/image';
import {
  isHapticsOn,
  isSoundOn,
  play,
  setHapticsOn,
  setSoundOn,
  hasHapticsSupport,
} from './lib/sound';
import { autoCropToSubject } from './lib/cutout';
import { CutoutStudio } from './components/CutoutStudio';
import { ComposeStudio } from './components/ComposeStudio';
import { Button, DropZone, Note, Sheet, Toggle } from './components/ui';
import { Sprite } from './components/Sprite';
import { navigate } from './lib/route';
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
  const [error, setError] = useState<string | null>(null);
  const [help, setHelp] = useState(false);
  const [sound, setSound] = useState(isSoundOn);
  const [haptics, setHaptics] = useState(isHapticsOn);

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

  const loadFrame = useCallback(async (file: File) => {
    setError(null);
    try {
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
  }, []);

  const handleCutoutDone = useCallback(async (result: ImageData) => {
    const bmp = await createImageBitmap(imageDataToCanvas(result));
    setFrameResult(bmp);
    setStep(3);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, []);

  const restart = useCallback(() => {
    setStep(1);
    setFrameSource(null);
    setFrameFull(null);
    setAutoCropped(false);
    setFrameResult(null);
    setError(null);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, []);

  const goto = (next: Step) => {
    setStep(next);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const canGo = (s: Step) => (s === 1 ? true : s === 2 ? !!photo : !!photo && !!frameResult);

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
            active={step === 3}
            onBack={() => goto(2)}
            onChangePhoto={() => goto(1)}
            onRestart={restart}
          />
        </div>
      )}

      <div className="footer">
        <p>
          <IconLock size={14} /> 画像はこの端末の中だけで処理されます。どこにも送信されません。
        </p>
        {/*
          ここには応援ページへの静かな入口があった。
          決済を外したので、行き先は「知らせるだけ」のページになっている。
          お金の話はしないが、知ってもらえると助かるのは変わらないので残す。
        */}
        <button type="button" className="link-quiet" onClick={() => navigate('share')}>
          このツールを人に知らせる
        </button>
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
              画像はインターネットに送られません。すべてこの端末の中で処理します。
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
