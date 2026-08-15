/**
 * どの画面を出すかを決めるだけの層。
 *
 * つくる画面（App）は、共有ページへ寄り道して戻ってきても
 * そのまま続きから使えるように、外さずに隠しておく。
 * 写真もフレームも、手でなおした跡も、ここで消えてしまうと
 * 「寄り道したせいで作りかけが消えた」ことになる。それだけは避ける。
 */
import App from './App';
import { SharePage } from './components/SharePage';
import { useRoute } from './lib/route';

export default function Root() {
  const route = useRoute();

  return (
    <>
      <div style={route === 'maker' ? undefined : { display: 'none' }}>
        <App active={route === 'maker'} />
      </div>
      {route === 'share' && <SharePage />}
    </>
  );
}
