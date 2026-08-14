import { beforeEach, describe, expect, it, vi } from 'vitest';

const firebase = vi.hoisted(() => ({
  addDoc: vi.fn(),
  arrayUnion: vi.fn(),
  collection: vi.fn(),
  deleteDoc: vi.fn(),
  doc: vi.fn((_db: unknown, ...parts: string[]) => parts.join('/')),
  getDoc: vi.fn(),
  onSnapshot: vi.fn(),
  serverTimestamp: vi.fn(() => 'server-time'),
  setDoc: vi.fn(),
  updateDoc: vi.fn(),
}));

vi.mock('firebase/firestore', () => firebase);
vi.mock('../../auth/firebase', () => ({ firestore: () => ({}) }));

import { createRoomDoc } from './firestoreRelay';

describe('Firestore の部屋作成', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('未作成ルームを先に読まず、新規作成を直接試す', async () => {
    firebase.setDoc.mockResolvedValueOnce(undefined);

    const code = await createRoomDoc('uid-host', 'ホスト');

    expect(code).toHaveLength(6);
    expect(firebase.getDoc).not.toHaveBeenCalled();
    expect(firebase.setDoc).toHaveBeenCalledOnce();
    expect(firebase.setDoc).toHaveBeenCalledWith(`rooms/${code}`, {
      code,
      hostUid: 'uid-host',
      hostName: 'ホスト',
      members: ['uid-host'],
      seats: {},
      guests: {},
      createdAt: 'server-time',
    });
  });

  it('既存コードをルールに拒否されたら別コードで再試行する', async () => {
    firebase.setDoc
      .mockRejectedValueOnce({ code: 'permission-denied' })
      .mockResolvedValueOnce(undefined);

    const code = await createRoomDoc('uid-host', 'ホスト');

    expect(code).toHaveLength(6);
    expect(firebase.setDoc).toHaveBeenCalledTimes(2);
  });

  it('通信エラーなど、コード重複ではない失敗は隠さない', async () => {
    const failure = { code: 'unavailable' };
    firebase.setDoc.mockRejectedValueOnce(failure);

    await expect(createRoomDoc('uid-host', 'ホスト')).rejects.toBe(failure);
    expect(firebase.setDoc).toHaveBeenCalledOnce();
  });

  it('5回とも既存コードなら理由を示して終了する', async () => {
    firebase.setDoc.mockRejectedValue({ code: 'permission-denied' });

    await expect(createRoomDoc('uid-host', 'ホスト')).rejects.toThrow(
      '部屋を作れませんでした（時間をおいてやり直してください）',
    );
    expect(firebase.setDoc).toHaveBeenCalledTimes(5);
  });
});
