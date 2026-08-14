/**
 * 接続とアプリ状態（T6 / 第5段階 T48）。
 *
 * ★クライアントは乱数を持たない（§4.2）。
 *   シャッフル・ドロー・コインは intent() で卓に依頼する。
 * ★クライアントは状態を自分で進めない（§4.1）。
 *   dispatch() は送るだけ。盤面は必ず卓から返ってきた state で置き換える。
 *
 * ★接続先は2つある。どちらでも上の2つは変わらない。
 *   local  … 同じネットワークの WebSocket サーバー（第2段階）
 *   online … ホストのブラウザが持つ卓に Firestore 経由で繋ぐ（第5段階 T48）
 */
import { create } from 'zustand';
import {
  buildCardIndex,
  decode,
  encode,
  type ActionRequest,
  type CardIndex,
  type ClientMessage,
  type GameState,
  type Intent,
  type PlayerId,
  type PresenceEntry,
  type ServerMessage,
  type SubmittedDeck,
} from '@pokeca/shared';
import { loadCardPool } from '../cards/cardPool';
import { firestoreRooms } from './online/firestoreRelay';
import {
  hostOnlineRoom,
  joinOnlineRoom,
  type OnlineSession,
  type SeatPresence,
} from './online/session';
import type { RoomsApi } from './online/rooms';

const STORAGE_KEY = 'pokeca-session';

interface StoredSession {
  roomCode: string;
  playerId: PlayerId;
  displayName: string;
}

function loadSession(): StoredSession | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as StoredSession) : null;
  } catch {
    return null;
  }
}

function saveSession(session: StoredSession | null): void {
  try {
    if (session) localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* localStorage が使えなくても動く */
  }
}

function serverUrl(): string {
  const configured = import.meta.env['VITE_WS_URL'] as string | undefined;
  if (configured) return configured;
  // Tailscale 上の別端末から開いたときも、同じホストのサーバーに繋ぐ
  return `ws://${window.location.hostname}:8787`;
}

/** 例外の文言。知らない形なら決め打ちの日本語にする（英語をそのまま画面に出さない） */
function reason(cause: unknown, fallback: string): string {
  const message = cause instanceof Error ? cause.message : '';
  return /[ぁ-んァ-ヶ一-龠]/.test(message) ? message : fallback;
}

export type ConnectionStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting';

/** 接続先。オンラインでは自分がホストか客かで送り先が変わる */
export type TransportMode = 'local' | 'online';

/** オンライン対戦を始めるときに渡すもの。★uid はアカウントの UID（席の身元） */
export interface OnlineStart {
  uid: string;
  displayName: string;
  deck?: SubmittedDeck;
  /** 試験で差し替えるため。既定は Firestore */
  rooms?: RoomsApi;
}

interface GameStore {
  status: ConnectionStatus;
  mode: TransportMode;
  /** オンラインのとき、自分がホストか */
  isHost: boolean;
  error: string | null;
  roomCode: string | null;
  playerId: PlayerId | null;
  displayName: string;
  state: GameState | null;
  cardIndex: CardIndex | null;
  presence: PresenceEntry[];

  createRoom: (displayName: string, deck?: SubmittedDeck) => void;
  joinRoom: (roomCode: string, displayName: string, deck?: SubmittedDeck) => void;
  /** オンライン: 部屋を建てて卓を持つ */
  createOnlineRoom: (start: OnlineStart) => Promise<void>;
  /** オンライン: 部屋コードで入る */
  joinOnlineRoom: (roomCode: string, start: OnlineStart) => Promise<void>;
  /** 保存済みセッションがあれば自動で戻る（★ローカル接続だけ） */
  resume: () => void;
  dispatch: (action: ActionRequest) => void;
  intent: (intent: Intent) => void;
  leave: () => void;
  clearError: () => void;
}

/** 相手が切れている間は盤面を進めない（接続先が変わっても判断は同じ） */
function canOperate(current: Pick<GameStore, 'status' | 'presence' | 'playerId'>): boolean {
  if (current.status !== 'connected') return false;
  return !current.presence.some(
    (seat) => seat.playerId !== current.playerId && !seat.connected,
  );
}

let socket: WebSocket | null = null;
let pending: ClientMessage | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let online: OnlineSession | null = null;

export const useGameStore = create<GameStore>((set, get) => {
  const send = (message: ClientMessage): void => {
    if (socket?.readyState === WebSocket.OPEN) socket.send(encode(message));
  };

  const connect = (firstMessage: ClientMessage): void => {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    socket?.close();
    pending = firstMessage;
    set({ status: get().roomCode ? 'reconnecting' : 'connecting', error: null });

    const next = new WebSocket(serverUrl());
    socket = next;

    next.addEventListener('open', () => {
      if (pending) send(pending);
      pending = null;
    });

    next.addEventListener('message', (event) => {
      const message = decode<ServerMessage>(String(event.data));
      if (!message) return;

      switch (message.type) {
        case 'joined': {
          const displayName = get().displayName;
          saveSession({ roomCode: message.roomCode, playerId: message.playerId, displayName });
          set({
            status: 'connected',
            roomCode: message.roomCode,
            playerId: message.playerId,
            cardIndex: buildCardIndex(message.cards),
            error: null,
          });
          break;
        }
        case 'state':
          set({ state: message.state });
          break;
        case 'presence':
          set({ presence: message.players });
          break;
        case 'error':
          set({ error: message.message });
          break;
        case 'hello':
        case 'pong':
          break;
      }
    });

    next.addEventListener('close', () => {
      if (socket !== next) return;
      const { roomCode, playerId, displayName } = get();
      if (!roomCode || !playerId) {
        set({ status: 'idle' });
        return;
      }
      set({ status: 'reconnecting' });
      reconnectTimer = setTimeout(() => {
        connect({ type: 'joinRoom', roomCode, displayName, playerId });
      }, 1000);
    });

    next.addEventListener('error', () => {
      set({ error: 'サーバーに接続できません（サーバーを起動していますか？）' });
    });
  };

  /**
   * オンライン対戦の受け口。ホストでもゲストでも同じものを使う。
   * ★カード定義は通信させない。自分の端末に読み込んだプールで画面を描く（絶対制約2）。
   */
  const onlineHandlers = () => ({
    onState: (state: GameState) => set({ state }),
    onSeats: (seats: readonly SeatPresence[], myPlayerId: PlayerId | null) => {
      set({
        presence: seats.map((seat) => ({
          playerId: seat.playerId,
          displayName: seat.displayName,
          connected: seat.connected,
        })),
        ...(myPlayerId ? { playerId: myPlayerId } : {}),
      });
    },
    onError: (message: string) => set({ error: message }),
  });

  /** オンラインを始める前の片づけ。★ローカル接続の再接続タイマーを必ず止める */
  const beginOnline = (displayName: string): void => {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    saveSession(null);
    const closing = socket;
    socket = null;
    closing?.close();
    online?.close();
    online = null;
    set({
      status: 'connecting',
      mode: 'online',
      displayName,
      roomCode: null,
      playerId: null,
      state: null,
      presence: [],
      error: null,
      // 対戦中のカード定義も自分の手元のプールから引く
      cardIndex: loadCardPool().index,
    });
  };

  const stored = loadSession();

  return {
    status: 'idle',
    mode: 'local',
    isHost: false,
    error: null,
    roomCode: null,
    playerId: null,
    displayName: stored?.displayName ?? '',
    state: null,
    cardIndex: null,
    presence: [],

    createRoom: (displayName, deck) => {
      set({ displayName, mode: 'local', isHost: false, roomCode: null, playerId: null, state: null });
      connect({ type: 'createRoom', displayName, deck });
    },

    joinRoom: (roomCode, displayName, deck) => {
      set({ displayName, mode: 'local', isHost: false, roomCode: null, playerId: null, state: null });
      connect({ type: 'joinRoom', roomCode: roomCode.trim().toUpperCase(), displayName, deck });
    },

    createOnlineRoom: async (start) => {
      beginOnline(start.displayName);
      const pool = loadCardPool().index.all;
      try {
        online = await hostOnlineRoom({
          uid: start.uid,
          displayName: start.displayName,
          ...(start.deck ? { deck: start.deck } : {}),
          cardPool: pool,
          rooms: start.rooms ?? firestoreRooms,
          handlers: onlineHandlers(),
        });
        set({ status: 'connected', isHost: true, roomCode: online.code });
      } catch (cause) {
        set({ status: 'idle', mode: 'local', error: reason(cause, '部屋を作れませんでした') });
      }
    },

    joinOnlineRoom: async (roomCode, start) => {
      beginOnline(start.displayName);
      try {
        online = await joinOnlineRoom({
          code: roomCode.trim().toUpperCase(),
          uid: start.uid,
          displayName: start.displayName,
          ...(start.deck ? { deck: start.deck } : {}),
          rooms: start.rooms ?? firestoreRooms,
          handlers: onlineHandlers(),
        });
        set({ status: 'connected', isHost: false, roomCode: online.code });
      } catch (cause) {
        set({ status: 'idle', mode: 'local', error: reason(cause, '部屋に入れませんでした') });
      }
    },

    resume: () => {
      const session = loadSession();
      // ★オンラインの卓はホストのブラウザにしかない。読み込み直しでは戻れない
      if (!session || get().status !== 'idle' || get().mode === 'online') return;
      set({
        displayName: session.displayName,
        roomCode: session.roomCode,
        playerId: session.playerId,
      });
      connect({
        type: 'joinRoom',
        roomCode: session.roomCode,
        displayName: session.displayName,
        playerId: session.playerId,
      });
    },

    dispatch: (action) => {
      if (!canOperate(get())) return;
      if (get().mode === 'online') online?.submitAction(action);
      else send({ type: 'action', action });
    },
    intent: (intent) => {
      if (!canOperate(get())) return;
      if (get().mode === 'online') online?.submitIntent(intent);
      else send({ type: 'intent', intent });
    },

    leave: () => {
      if (reconnectTimer) clearTimeout(reconnectTimer);
      saveSession(null);
      const closing = socket;
      socket = null;
      closing?.close();
      online?.close();
      online = null;
      set({
        status: 'idle',
        mode: 'local',
        isHost: false,
        roomCode: null,
        playerId: null,
        state: null,
        presence: [],
        error: null,
      });
    },

    clearError: () => set({ error: null }),
  };
});

/** 自分以外の席のID */
export function useOpponentId(): PlayerId | null {
  return useGameStore((s) => {
    if (!s.state || !s.playerId) return null;
    return Object.keys(s.state.players).find((id) => id !== s.playerId) ?? null;
  });
}
