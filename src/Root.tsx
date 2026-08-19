/**
 * どの画面を出すかを決めるだけの層。
 *
 * つくる画面（App）は、共有ページへ寄り道して戻ってきても
 * そのまま続きから使えるように、外さずに隠しておく。
 * 写真もフレームも、手でなおした跡も、ここで消えてしまうと
 * 「寄り道したせいで作りかけが消えた」ことになる。それだけは避ける。
 */
import { Suspense, lazy, useEffect } from 'react';
import App from './App';
import { SharePage } from './components/SharePage';
import { useRoute } from './lib/route';

/*
  スタジオ（うごく素材の背景けし）は、必要になったときだけ取りにいく。

  ここを静的に import すると、動画を触らない人——つくる画面しか開かない人にも、
  動画まわりのコードと、その見た目のための CSS が最初から降ってくる。
  このツールは「スマホしか持っていない人」が前提なので、
  開いていない道具の重さを先に払わせない。
*/
const StudioPage = lazy(() => import('./components/studio/StudioPage'));

export default function Root() {
  const route = useRoute();

  /*
    舞台は暗い。色の決まりごとが別なので、体（body）ごと切り替える。

    クラスを付ける先が body なのは、画面いっぱいに出るシート（保存の行き先を
    選ぶところ）が body の直下に出るため。スタジオの中だけに色を置くと、
    シートだけ紙の色のまま取り残される。
  */
  useEffect(() => {
    document.body.classList.toggle('studio-theme', route === 'studio');
    return () => document.body.classList.remove('studio-theme');
  }, [route]);

  return (
    <>
      <div style={route === 'maker' ? undefined : { display: 'none' }}>
        <App active={route === 'maker'} />
      </div>
      {route === 'share' && <SharePage />}
      {route === 'studio' && (
        <Suspense fallback={<div className="st-boot">よみこんでいます…</div>}>
          <StudioPage />
        </Suspense>
      )}
    </>
  );
}
