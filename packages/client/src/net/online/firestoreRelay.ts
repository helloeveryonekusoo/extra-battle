/**
 * Firestore を中継に使う実装（第5段階 T48）。
 *
 * ★置き場は `firestore.rules` と1対1で対応させる。
 *
 *     rooms/{roomId}                 部屋。hostUid と members だけがルールの判断材料
 *     rooms/{roomId}/state/{uid}     その人に見える盤面（★ホストだけが書ける）
 *     rooms/{roomId}/intents/{id}    ゲストの要求（★書いた本人の uid を必ず入れる）
 *
 * ★盤面は「その人のぶん」を別の書類に置く。
 *   1つにまとめると、相手の手札まで読めてしまう。
 */
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDoc,
  onSnapshot,
  serverTimestamp,
  setDoc,
  updateDoc,
  arrayUnion,
  type Firestore,
} from 'firebase/firestore';
import type { GameState } from '@pokeca/shared';
import { firestore } from '../../auth/firebase';
import type { Relay, RelayIntent, Seat, StateNotice } from './relay';
import type { GuestProfile, RoomDoc, RoomsApi, StateUpdate } from './rooms';

/** ルームコード。紛らわしい 0/O/1/I を使わない（第2段階と同じ考え方） */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const ROOM_CODE_LENGTH = 6;

export function newRoomCode(): string {
  const values = new Uint32Array(ROOM_CODE_LENGTH);
  crypto.getRandomValues(values);
  return [...values].map((n) => CODE_ALPHABET[n % CODE_ALPHABET.length]).join('');
}

const db = (): Firestore => {
  const instance = firestore();
  if (!instance) throw new Error('Firebase の設定がありません（オンライン対戦は使えません）');
  return instance;
};

const roomRef = (roomId: string) => doc(db(), 'rooms', roomId);
const stateRef = (roomId: string, uid: string) => doc(db(), 'rooms', roomId, 'state', uid);
const intentsRef = (roomId: string) => collection(db(), 'rooms', roomId, 'intents');

/** 書類から読んだものを RoomDoc の形に整える。欠けていても落ちない */
function toRoomDoc(data: Record<string, unknown>): RoomDoc {
  return {
    code: String(data['code'] ?? ''),
    hostUid: String(data['hostUid'] ?? ''),
    hostName: String(data['hostName'] ?? ''),
    members: Array.isArray(data['members']) ? (data['members'] as string[]) : [],
    seats: (data['seats'] ?? {}) as RoomDoc['seats'],
    guests: (data['guests'] ?? {}) as RoomDoc['guests'],
  };
}

/**
 * 部屋を作る。★ルームコードをそのまま書類IDにして、コードから引けるようにする。
 *
 * ★同じコードが空いているか必ず確かめる（T49）。
 *   10億通りあるので普通は当たらないが、当たったときに黙って
 *   人の対戦部屋を上書きするのは、確率がいくら低くても許されない。
 */
export async function createRoomDoc(hostUid: string, hostName: string): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = newRoomCode();
    if ((await getDoc(roomRef(code))).exists()) continue;
    const value: RoomDoc = { code, hostUid, hostName, members: [hostUid], seats: {}, guests: {} };
    await setDoc(roomRef(code), { ...value, createdAt: serverTimestamp() });
    return code;
  }
  throw new Error('部屋を作れませんでした（時間をおいてやり直してください）');
}

/** 部屋をたたむ。ゲストの watch が空を受け取って終わりに気づく */
export async function closeRoomDoc(code: string): Promise<void> {
  await deleteDoc(roomRef(code));
}

export async function readRoomDoc(code: string): Promise<RoomDoc | null> {
  const snapshot = await getDoc(roomRef(code));
  return snapshot.exists() ? toRoomDoc(snapshot.data()) : null;
}

/**
 * ゲストが自分を members に足し、名乗りを置く。
 * ★ルールでは「members と guests だけを、自分の分だけ」触る更新しか通らない。
 */
export async function joinRoomDoc(
  code: string,
  uid: string,
  profile: GuestProfile,
): Promise<void> {
  await updateDoc(roomRef(code), {
    members: arrayUnion(uid),
    // undefined は Firestore が受け取らないので、デッキがなければ入れない
    [`guests.${uid}`]: profile.deck
      ? { displayName: profile.displayName, deck: profile.deck }
      : { displayName: profile.displayName },
  });
}

export function watchRoomDoc(code: string, onChange: (room: RoomDoc | null) => void): () => void {
  return onSnapshot(roomRef(code), (snapshot) => {
    onChange(snapshot.exists() ? toRoomDoc(snapshot.data()) : null);
  });
}

/** ゲスト側: 自分あての盤面と知らせを受け取る */
export function watchState(
  code: string,
  uid: string,
  onUpdate: (update: StateUpdate) => void,
): () => void {
  return onSnapshot(stateRef(code, uid), (snapshot) => {
    const data = snapshot.data();
    if (!data) return;
    const update: StateUpdate = {};
    if (typeof data['state'] === 'string') {
      update.state = JSON.parse(data['state']) as GameState;
    }
    const notice = data['notice'];
    if (
      typeof notice === 'object' &&
      notice !== null &&
      typeof (notice as StateNotice).message === 'string'
    ) {
      update.notice = notice as StateNotice;
    }
    if (update.state || update.notice) onUpdate(update);
  });
}

/** ゲスト側: 要求を送る */
export async function sendIntent(
  code: string,
  uid: string,
  body: RelayIntent['body'],
): Promise<void> {
  await addDoc(intentsRef(code), { uid, body: JSON.stringify(body), at: serverTimestamp() });
}

/**
 * ホスト側の中継。
 *
 * ★盤面は JSON 文字列にして1フィールドに入れる。
 *   Firestore は入れ子の配列を持てないうえ、盤面は入れ子が深い。
 *   文字列にすれば構造を気にせず往復でき、1MBの上限にも収まる。
 */
export function firestoreRelay(code: string): Relay {
  return {
    /*
     * ★盤面と知らせは同じ書類に重ねる（merge）。
     *   別々の書類にするとルールを1本増やすことになるし、
     *   丸ごと書き換えると、断った理由が次の盤面ですぐ消える。
     */
    publishState: async (uid, state) => {
      await setDoc(
        stateRef(code, uid),
        { state: JSON.stringify(state), at: serverTimestamp() },
        { merge: true },
      );
    },
    publishNotice: async (uid, notice) => {
      await setDoc(stateRef(code, uid), { notice }, { merge: true });
    },
    publishSeats: async (seats: readonly Seat[]) => {
      await updateDoc(roomRef(code), {
        seats: Object.fromEntries(seats.map((seat) => [seat.uid, seat.playerId])),
        members: seats.map((seat) => seat.uid),
      });
    },
    onIntent: (handler) =>
      onSnapshot(intentsRef(code), (snapshot) => {
        for (const change of snapshot.docChanges()) {
          if (change.type !== 'added') continue;
          const data = change.doc.data();
          if (typeof data['uid'] !== 'string' || typeof data['body'] !== 'string') continue;
          handler({
            id: change.doc.id,
            uid: data['uid'],
            body: JSON.parse(data['body']) as RelayIntent['body'],
          });
        }
      }),
    ackIntent: async (id) => {
      await deleteDoc(doc(intentsRef(code), id));
    },
  };
}

/** アプリが実際に使う口 */
export const firestoreRooms: RoomsApi = {
  create: createRoomDoc,
  read: readRoomDoc,
  join: joinRoomDoc,
  watch: watchRoomDoc,
  watchState,
  sendIntent,
  close: closeRoomDoc,
  relay: firestoreRelay,
};
