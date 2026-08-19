/**
 * 前に作ったフレームを、この端末にだけ覚えておく。
 *
 * ── なぜ「覚えておく」を押させるのか ──
 *
 * この道具は「画像はこの端末の中だけで処理されます」と言っている。
 * 黙って残すと、その約束の意味が変わる。端末の外に出ないのは本当でも、
 * 閉じたあとも残っているのは、利用者が言われていない話だから。
 * だから、残すかどうかは押して決めてもらう。押さなければ何も書かない。
 *
 * ── なぜ IndexedDB なのか ──
 *
 * 背景をけしたフレームは透過つきの PNG で、数百KB〜数MB になる。
 * localStorage は文字しか置けないので base64 にする必要があり、
 * 3割ふくらむうえに上限（だいたい5MB）に当たる。
 * IndexedDB なら中身をそのまま置ける。
 *
 * ── なぜ localStorage の札を別に持つのか ──
 *
 * 「覚えたものがあるか」は、フレームをえらぶ画面を描くときに要る。
 * それを IndexedDB に聞くと、開くだけで非同期の往復が1回増える。
 * 有る/無いだけなら1文字で足りるので、そこは同期で読める場所に置いて、
 * **実際に使うと押されるまで IndexedDB を開かない**。
 */

const DB_NAME = 'aeframe';
const STORE = 'kept';
const KEY = 'frame';
/** IndexedDB を開かずに「あるか無いか」だけ即答するための札 */
const FLAG = 'aeframe.kept';

export type KeptFrame = { blob: Blob; savedAt: number };

/*
  中身は Blob ではなく ArrayBuffer で置く。
  Blob をそのまま IndexedDB に入れるのは仕様上できることになっているが、
  端末によっては取り出したあとで読めなくなることがある。
  ArrayBuffer と種類の文字列に分けておけば、その揺れを踏まない。
*/
type Row = { buf: ArrayBuffer; type: string; savedAt: number };

function setFlag(on: boolean) {
  try {
    if (on) localStorage.setItem(FLAG, '1');
    else localStorage.removeItem(FLAG);
  } catch {
    /* localStorage が使えない環境では札を持たない（＝毎回「無い」扱い） */
  }
}

/** 覚えたフレームがあるか。IndexedDB は開かない。 */
export function hasKeptFrame(): boolean {
  try {
    return localStorage.getItem(FLAG) === '1' && 'indexedDB' in window;
  } catch {
    return false;
  }
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB を開けませんでした'));
    // 別のタブが古い版を開いたまま、などで永久に待たないように
    req.onblocked = () => reject(new Error('IndexedDB がふさがっています'));
  });
}

function run<T>(db: IDBDatabase, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest) {
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    req.onsuccess = () => resolve(req.result as T);
    req.onerror = () => reject(req.error ?? new Error('書き込みに失敗しました'));
    tx.onabort = () => reject(tx.error ?? new Error('書き込みが中断されました'));
  });
}

export async function keepFrame(blob: Blob): Promise<void> {
  const row: Row = {
    buf: await blob.arrayBuffer(),
    type: blob.type || 'image/png',
    savedAt: Date.now(),
  };
  const db = await open();
  try {
    await run(db, 'readwrite', (s) => s.put(row, KEY));
    setFlag(true);
  } finally {
    db.close();
  }
}

/**
 * 覚えたフレームを取り出す。
 * 無ければ null を返し、あわせて札も下ろす（端末が中身だけ消すことがある）。
 */
export async function loadKeptFrame(): Promise<KeptFrame | null> {
  let db: IDBDatabase;
  try {
    db = await open();
  } catch {
    setFlag(false);
    return null;
  }
  try {
    const row = await run<Row | undefined>(db, 'readonly', (s) => s.get(KEY));
    // 長さまで見る。中身が空の記録が残っていると、読めない画像を渡してしまう。
    if (!row?.buf?.byteLength) {
      setFlag(false);
      return null;
    }
    return { blob: new Blob([row.buf], { type: row.type }), savedAt: row.savedAt };
  } catch {
    setFlag(false);
    return null;
  } finally {
    db.close();
  }
}

export async function forgetFrame(): Promise<void> {
  // 先に札を下ろす。中身を消すほうが失敗しても、入口は閉じておきたい。
  setFlag(false);
  const db = await open();
  try {
    await run(db, 'readwrite', (s) => s.delete(KEY));
  } finally {
    db.close();
  }
}
