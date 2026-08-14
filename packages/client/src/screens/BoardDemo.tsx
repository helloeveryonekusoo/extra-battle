/**
 * T8/T9 の確認ページ。サンプル状態を盤面に流し込み、操作も試せる。
 *
 * ★このページはサーバーに繋がっていないので、乱数を伴う操作（シャッフル・コイン・
 *   じゃんけん）は実行できない（メニュー上で無効になる）。
 *   クライアントに乱数を持たせないという §4.2 の原則をデモでも崩さないため。
 */
import { useMemo, useState } from 'react';
import { applyAction, type Action, type ActionRequest, type GameState } from '@pokeca/shared';
import { Board } from '../components/board/Board';
import { DamageCalculationPanel } from '../components/board/DamageCalculationPanel';
import { DragProvider } from '../interaction/dnd';
import { useTableController } from '../interaction/useTableController';
import { PokemonCheck } from './PokemonCheck';
import { WarningToasts } from '../components/board/WarningToasts';
import { buildDemoState, DEMO_ME } from '../cards/demoState';
import { sampleCardIndex } from '../cards/sampleCards';

function DemoInner({ initial }: { initial: GameState }) {
  const [state, setState] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [damagePanelOpen, setDamagePanelOpen] = useState(false);

  const dispatcher = useMemo(
    () => ({
      dispatch: (action: ActionRequest) => {
        setError(null);
        setState((current) => {
          try {
            return applyAction(
              current,
              { ...action, actorId: DEMO_ME, at: Date.now() } as Action,
              // カード定義を渡すとルール警告も出る（第2段階 §2）
              { cards: sampleCardIndex },
            );
          } catch (e) {
            setError(e instanceof Error ? e.message : '操作できませんでした');
            return current;
          }
        });
      },
      // 乱数はサーバーの仕事。デモでは受け付けない
      intent: () => setError('この操作はサーバーに接続しているときだけ実行できます'),
      canRandomize: false,
    }),
    [],
  );

  const controller = useTableController({
    state,
    cardIndex: sampleCardIndex,
    viewerId: DEMO_ME,
    dispatcher,
  });

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div
        style={{
          padding: '5px 16px',
          background: 'rgba(201,162,39,0.08)',
          borderBottom: '1px solid var(--border)',
          color: 'var(--text-dim)',
          fontSize: 10,
        }}
      >
        盤面デモ。カードをドラッグ、右クリックでメニュー、HPバーをクリックでダメカン +10（Shift +50 /
        右クリック −10）。
        {error && <span style={{ color: 'var(--danger)', marginLeft: 12 }}>{error}</span>}
        <button
          type="button"
          style={{ float: 'right' }}
          onClick={() => setDamagePanelOpen((open) => !open)}
        >
          ダメージ計算
        </button>
      </div>
      <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
        <div style={{ flex: 1, minWidth: 0, minHeight: 0 }}>
          <Board
            state={state}
            viewerId={DEMO_ME}
            cardIndex={sampleCardIndex}
            controller={controller}
          />
        </div>
        {damagePanelOpen && (
          <DamageCalculationPanel
            state={state}
            viewerId={DEMO_ME}
            cardIndex={sampleCardIndex}
            dispatch={dispatcher.dispatch}
            onClose={() => setDamagePanelOpen(false)}
          />
        )}
      </div>

      {state.phase === 'pokemonCheck' && (
        <PokemonCheck
          state={state}
          viewerId={DEMO_ME}
          cardIndex={sampleCardIndex}
          dispatch={dispatcher.dispatch}
          intent={dispatcher.intent}
          canRandomize={false}
        />
      )}

      <WarningToasts state={state} />
      {controller.overlay}
    </div>
  );
}

export function BoardDemo() {
  const initial = useMemo(() => buildDemoState(), []);

  if (!initial) {
    return (
      <p style={{ padding: 24, color: 'var(--text-dim)' }}>
        サンプルカードが読み込めませんでした。<code>data/cards/sample.json</code> を確認してください。
      </p>
    );
  }

  return (
    <DragProvider>
      <DemoInner initial={initial} />
    </DragProvider>
  );
}
