import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { sampleCardIndex } from '../cards/sampleCards';
import { saveDeck } from '../decks/deckStorage';
import { useGameStore } from '../net/store';
import { Lobby } from './Lobby';

/** アカウントの有無で画面が変わるので、ここだけ差し替える */
const account = vi.hoisted(() => ({
  value: { user: null as { uid: string; displayName: string } | null, loading: false, available: false },
}));
vi.mock('../auth/useAuth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../auth/useAuth')>()),
  useAccount: () => account.value,
}));

describe('ロビー', () => {
  beforeEach(() => {
    window.localStorage.clear();
    account.value = { user: null, loading: false, available: false };
    useGameStore.setState({
      status: 'idle',
      mode: 'local',
      error: null,
      roomCode: null,
      playerId: null,
      displayName: '',
    });
  });

  it('選択した保存デッキを部屋作成時に渡す', async () => {
    const card = sampleCardIndex.all[0]!;
    const deck = saveDeck({ name: '対戦用デッキ', cards: [{ functionalId: card.functionalId, count: 60 }] });
    const createRoom = vi.fn();
    useGameStore.setState({ createRoom });
    render(<Lobby />);

    fireEvent.change(screen.getByPlaceholderText('あなたの名前'), { target: { value: 'アリス' } });
    await waitFor(() =>
      expect((screen.getByLabelText('対戦に使うデッキ') as HTMLSelectElement).value).toBe(deck.id),
    );
    fireEvent.click(screen.getByRole('button', { name: '部屋を作る' }));

    expect(createRoom).toHaveBeenCalledWith('アリス', {
      name: '対戦用デッキ',
      cards: [{ functionalId: card.functionalId, count: 60 }],
    });
  });

  it('Firebase の設定がなければオンラインは選べない', async () => {
    render(<Lobby />);
    await screen.findByLabelText('対戦に使うデッキ');
    const onlineTab = screen.getByRole('radio', { name: 'オンライン' }) as HTMLButtonElement;
    expect(onlineTab.disabled).toBe(true);
    expect(screen.getByRole('radio', { name: '同じネットワーク' }).getAttribute('aria-checked')).toBe(
      'true',
    );
  });

  it('★ログインしていなければオンラインでは始められない', async () => {
    account.value = { user: null, loading: false, available: true };
    render(<Lobby />);
    await screen.findByLabelText('対戦に使うデッキ');

    fireEvent.change(screen.getByPlaceholderText('あなたの名前'), { target: { value: 'アリス' } });
    const host = screen.getByRole('button', { name: '部屋を作る' }) as HTMLButtonElement;
    expect(host.disabled).toBe(true);
    expect(screen.getByText(/オンライン対戦にはアカウントが要ります/)).toBeTruthy();
  });

  it('★オンラインではアカウントの UID で部屋を建てる', async () => {
    account.value = {
      user: { uid: 'uid-alice', displayName: 'アリス' },
      loading: false,
      available: true,
    };
    const createOnlineRoom = vi.fn();
    useGameStore.setState({ createOnlineRoom });
    render(<Lobby />);

    await waitFor(() =>
      expect((screen.getByPlaceholderText('あなたの名前') as HTMLInputElement).value).toBe('アリス'),
    );
    fireEvent.click(screen.getByRole('button', { name: '部屋を作る' }));

    expect(createOnlineRoom).toHaveBeenCalledWith({ uid: 'uid-alice', displayName: 'アリス' });
  });

  it('★オンラインでの参加も UID を添えて送る', async () => {
    account.value = {
      user: { uid: 'uid-bob', displayName: 'ボブ' },
      loading: false,
      available: true,
    };
    const joinOnlineRoom = vi.fn();
    useGameStore.setState({ joinOnlineRoom });
    render(<Lobby />);

    await waitFor(() =>
      expect((screen.getByPlaceholderText('あなたの名前') as HTMLInputElement).value).toBe('ボブ'),
    );
    fireEvent.change(screen.getByPlaceholderText('ABC123'), { target: { value: 'abcdef' } });
    fireEvent.click(screen.getByRole('button', { name: '参加する' }));

    expect(joinOnlineRoom).toHaveBeenCalledWith('ABCDEF', { uid: 'uid-bob', displayName: 'ボブ' });
  });
});
