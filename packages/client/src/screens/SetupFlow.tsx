/**
 * 対戦準備フロー（§T10）。
 * じゃんけん → 先攻後攻 → 7枚 → たね確認 → マリガン → サイド6 → 開始
 *
 * ★これはルール判定ではなく、手順を忘れないための道しるべ。
 *   「たねポケモンがいるか」は人間が見て自己申告する。アプリは判定しない。
 *   段は自由に進めたり戻したりできる。
 */
import { useState } from 'react';
import {
  cardsInZone,
  HIDDEN_FUNCTIONAL_ID,
  SETUP_STEP_LABEL,
  type ActionRequest,
  type CardIndex,
  type GameState,
  type Intent,
  type PlayerId,
  type SetupStep,
} from '@pokeca/shared';
import styles from './SetupFlow.module.css';

const STEP_ORDER: SetupStep[] = [
  'janken',
  'order',
  'draw',
  'mulligan',
  'place',
  'prizes',
  'reveal',
];

const HAND_SIZE = 7;
const PRIZE_COUNT = 6;

export interface SetupFlowProps {
  state: GameState;
  viewerId: PlayerId;
  cardIndex: CardIndex | null;
  dispatch: (action: ActionRequest) => void;
  intent: (intent: Intent) => void;
  canRandomize: boolean;
}

function Seats({
  state,
  viewerId,
  extra,
}: {
  state: GameState;
  viewerId: PlayerId;
  extra?: (playerId: PlayerId) => React.ReactNode;
}) {
  const setup = state.setup;
  return (
    <div className={styles.seats}>
      {Object.keys(state.players).map((playerId) => {
        const player = state.players[playerId]!;
        const progress = setup?.progress[playerId];
        return (
          <div
            key={playerId}
            className={`${styles.seat} ${playerId === viewerId ? styles.seatMine : ''}`}
          >
            <div className={styles.seatName}>
              {player.displayName || playerId}
              {playerId === viewerId && <span className={styles.tag}>自分</span>}
              {setup?.firstPlayer === playerId && <span className={styles.tag}>先攻</span>}
              {progress?.ready && <span className={`${styles.tag} ${styles.tagReady}`}>準備OK</span>}
            </div>
            <div className={styles.seatLine}>
              <span>山札</span>
              <b>{cardsInZone(state, playerId, 'deck').length}</b>
            </div>
            <div className={styles.seatLine}>
              <span>手札</span>
              <b>{cardsInZone(state, playerId, 'hand').length}</b>
            </div>
            <div className={styles.seatLine}>
              <span>サイド</span>
              <b>{cardsInZone(state, playerId, 'prize').length}</b>
            </div>
            <div className={styles.seatLine}>
              <span>場のポケモン</span>
              <b>{player.pokemon.length}</b>
            </div>
            <div className={styles.seatLine}>
              <span>マリガン</span>
              <b>{progress?.mulligans ?? 0}回</b>
            </div>
            {extra?.(playerId)}
          </div>
        );
      })}
    </div>
  );
}

export function SetupFlow({
  state,
  viewerId,
  cardIndex,
  dispatch,
  intent,
  canRandomize,
}: SetupFlowProps) {
  const [bonus, setBonus] = useState(0);
  const [collapsed, setCollapsed] = useState(false);
  const setup = state.setup;
  if (!setup) return null;

  const players = Object.keys(state.players);
  const opponentId = players.find((id) => id !== viewerId);
  const me = setup.progress[viewerId];
  const opponent = opponentId ? setup.progress[opponentId] : undefined;
  const bothSeated = players.length >= 2;

  const myDeck = cardsInZone(state, viewerId, 'deck').length;
  const myHand = cardsInZone(state, viewerId, 'hand');
  const myPrizes = cardsInZone(state, viewerId, 'prize').length;

  const step = (next: SetupStep) => dispatch({ type: 'setSetupStep', step: next });
  const currentIndex = STEP_ORDER.indexOf(setup.step);
  const bothReady = players.every((id) => setup.progress[id]?.ready);

  const nameOf = (id: PlayerId) => state.players[id]?.displayName ?? id;

  const readyToggle = (
    <button
      className={`${styles.button} ${me?.ready ? '' : styles.primary}`}
      onClick={() => dispatch({ type: 'setSetupReady', playerId: viewerId, ready: !me?.ready })}
    >
      {me?.ready ? '準備完了を取り消す' : 'この段を終えた'}
    </button>
  );

  const advance = (next: SetupStep, label = '次へ進む') => (
    <button className={`${styles.button} ${styles.primary}`} disabled={!bothReady} onClick={() => step(next)}>
      {label}
    </button>
  );

  let content: React.ReactNode = null;

  if (!bothSeated) {
    content = (
      <>
        <h2 className={styles.title}>相手を待っています</h2>
        <p className={styles.lead}>
          部屋コードを相手に伝えてください。2人そろうと対戦準備が始まります。
        </p>
      </>
    );
  } else if (setup.step === 'janken') {
    content = (
      <>
        <h2 className={styles.title}>じゃんけん</h2>
        <p className={styles.lead}>
          勝ったほうが先攻・後攻を選びます。結果はサーバーが決め、両者のログに残ります。
        </p>
        <div className={styles.row}>
          <button
            className={`${styles.button} ${styles.primary}`}
            disabled={!canRandomize}
            onClick={() =>
              intent({ type: 'randomChoice', label: 'じゃんけん', options: players })
            }
          >
            じゃんけんをする
          </button>
          {players.map((id) => (
            <button
              key={id}
              className={styles.button}
              onClick={() => dispatch({ type: 'setJankenWinner', playerId: id })}
            >
              {nameOf(id)}の勝ち
            </button>
          ))}
        </div>
        {setup.jankenWinner && (
          <p className={styles.note}>
            <b>{nameOf(setup.jankenWinner)}</b> の勝ちです。次で先攻・後攻を選びます。
          </p>
        )}
        <div className={styles.row}>
          <button
            className={`${styles.button} ${styles.primary}`}
            disabled={!setup.jankenWinner}
            onClick={() => step('order')}
          >
            次へ進む
          </button>
        </div>
        <p className={styles.note}>
          手元で実際にじゃんけんをしたなら、勝った側のボタンを押して結果だけ記録してもかまいません。
        </p>
      </>
    );
  } else if (setup.step === 'order') {
    const chooser = setup.jankenWinner;
    const iChoose = chooser === viewerId;
    content = (
      <>
        <h2 className={styles.title}>先攻・後攻を決める</h2>
        <p className={styles.lead}>
          {chooser ? `${nameOf(chooser)} が選びます。` : 'どちらが先攻か決めてください。'}
        </p>
        <div className={styles.row}>
          <button
            className={`${styles.button} ${styles.primary}`}
            disabled={Boolean(chooser) && !iChoose}
            onClick={() => dispatch({ type: 'setFirstPlayer', playerId: viewerId })}
          >
            自分が先攻
          </button>
          <button
            className={styles.button}
            disabled={!opponentId || (Boolean(chooser) && !iChoose)}
            onClick={() => opponentId && dispatch({ type: 'setFirstPlayer', playerId: opponentId })}
          >
            相手が先攻
          </button>
        </div>
        {setup.firstPlayer && (
          <p className={styles.note}>
            先攻は <b>{nameOf(setup.firstPlayer)}</b> です。
          </p>
        )}
        <div className={styles.row}>
          <button
            className={`${styles.button} ${styles.primary}`}
            disabled={!setup.firstPlayer}
            onClick={() => step('draw')}
          >
            次へ進む
          </button>
        </div>
      </>
    );
  } else if (setup.step === 'draw') {
    content = (
      <>
        <h2 className={styles.title}>山札を置いて、切って、7枚引く</h2>
        <p className={styles.lead}>
          デッキを卓に置き、シャッフルしてから7枚引きます。引いたカードは自分だけに見えます。
        </p>
        <div className={styles.row}>
          <button
            className={styles.button}
            disabled={!canRandomize}
            onClick={() => intent({ type: 'devDealSampleDeck', playerId: viewerId, size: 60 })}
          >
            サンプルの山札を置く（60枚）
          </button>
          <button
            className={styles.button}
            disabled={!canRandomize || myDeck === 0}
            onClick={() => intent({ type: 'shuffleDeck', playerId: viewerId })}
          >
            山札を切る
          </button>
          <button
            className={`${styles.button} ${styles.primary}`}
            disabled={!canRandomize || myDeck < HAND_SIZE || myHand.length > 0}
            onClick={() => intent({ type: 'drawCards', playerId: viewerId, count: HAND_SIZE })}
          >
            7枚引く
          </button>
        </div>
        <Seats state={state} viewerId={viewerId} />
        <div className={styles.row} style={{ marginTop: 14 }}>
          {readyToggle}
          {advance('mulligan')}
        </div>
        <p className={styles.note}>
          デッキ構築のバリデータはまだありません。今は開発用のサンプル山札を使ってください。
        </p>
      </>
    );
  } else if (setup.step === 'mulligan') {
    const revealedHand = myHand.every((c) =>
      players.every((p) => c.visibleTo.includes(p)),
    );
    content = (
      <>
        <h2 className={styles.title}>たね確認とマリガン</h2>
        <p className={styles.lead}>
          手札にたねポケモンがいるか、自分の目で確かめてください。
          <b>アプリは判定しません。</b>
          いなければ手札を相手に見せてから引き直します。
        </p>

        <div className={styles.hand}>
          {myHand.map((card) => (
            <span
              key={card.instanceId}
              className={`${styles.handCard} ${
                card.functionalId === HIDDEN_FUNCTIONAL_ID ? styles.hiddenCard : ''
              }`}
            >
              {card.functionalId === HIDDEN_FUNCTIONAL_ID
                ? '非公開'
                : (cardIndex?.byFunctionalId.get(card.functionalId)?.name ?? '？')}
            </span>
          ))}
          {myHand.length === 0 && <span className={styles.hiddenCard}>手札がありません</span>}
        </div>

        <div className={styles.row}>
          <button
            className={styles.button}
            disabled={myHand.length === 0}
            onClick={() =>
              dispatch({
                type: 'setCardVisibility',
                cardIds: myHand.map((c) => c.instanceId),
                visibleTo: players,
              })
            }
          >
            手札を相手に見せる
          </button>
          <button
            className={styles.button}
            disabled={myHand.length === 0 || !revealedHand}
            onClick={() =>
              dispatch({
                type: 'setCardVisibility',
                cardIds: myHand.map((c) => c.instanceId),
                visibleTo: [viewerId],
              })
            }
          >
            手札を伏せ直す
          </button>
          <button
            className={`${styles.button} ${styles.danger}`}
            disabled={!canRandomize || myHand.length === 0}
            onClick={() => intent({ type: 'mulligan', playerId: viewerId, handSize: HAND_SIZE })}
          >
            マリガン（引き直す）
          </button>
        </div>

        {opponent && opponent.mulligans > 0 && (
          <>
            <p className={`${styles.note} ${styles.warn}`}>
              相手は <b>{opponent.mulligans}回</b> マリガンしました。
              最大 {opponent.mulligans} 枚まで追加で引けます。引く枚数を宣言してください。
            </p>
            <div className={styles.row}>
              <input
                type="number"
                min={0}
                max={opponent.mulligans}
                value={bonus}
                onChange={(e) => setBonus(Number(e.target.value))}
                style={{
                  width: 76,
                  padding: '8px 10px',
                  background: 'var(--bg)',
                  border: '1px solid var(--border)',
                  borderRadius: 6,
                  color: 'var(--text)',
                }}
              />
              <button
                className={styles.button}
                onClick={() =>
                  dispatch({ type: 'declareBonusDraw', playerId: viewerId, count: bonus })
                }
              >
                {bonus}枚 引くと宣言
              </button>
              <button
                className={styles.button}
                disabled={!canRandomize || bonus === 0}
                onClick={() => intent({ type: 'drawCards', playerId: viewerId, count: bonus })}
              >
                宣言した枚数を引く
              </button>
            </div>
            {me?.bonusDraw !== null && me?.bonusDraw !== undefined && (
              <p className={styles.note}>
                宣言済み: <b>{me.bonusDraw}枚</b>
              </p>
            )}
          </>
        )}

        <Seats state={state} viewerId={viewerId} />
        <div className={styles.row} style={{ marginTop: 14 }}>
          {readyToggle}
          {advance('place')}
        </div>
      </>
    );
  } else if (setup.step === 'place') {
    content = (
      <>
        <h2 className={styles.title}>バトル場とベンチにウラのまま出す</h2>
        <p className={styles.lead}>
          手札のたねポケモンを、<b>ウラのまま</b>バトル場に1匹、ベンチに好きなだけ置きます。
          手札のカードを右クリックして「ウラのまま場に出す」を選ぶか、盤面へドラッグしてから
          「ウラにする」を選んでください。
        </p>
        <Seats state={state} viewerId={viewerId} />
        <div className={styles.row} style={{ marginTop: 14 }}>
          {readyToggle}
          {advance('prizes')}
        </div>
        <p className={styles.note}>
          この案内は「盤面を操作する」で一時的に畳めます。置き終わったら戻ってきてください。
        </p>
      </>
    );
  } else if (setup.step === 'prizes') {
    content = (
      <>
        <h2 className={styles.title}>サイドを置く</h2>
        <p className={styles.lead}>
          山札の上から6枚を、中身を見ずにサイドへ置きます。どのカードが行くかはサーバーが決めます。
        </p>
        <div className={styles.row}>
          <button
            className={`${styles.button} ${styles.primary}`}
            disabled={!canRandomize || myPrizes > 0 || myDeck < PRIZE_COUNT}
            onClick={() => intent({ type: 'dealPrizes', playerId: viewerId, count: PRIZE_COUNT })}
          >
            サイドを6枚置く
          </button>
        </div>
        <Seats state={state} viewerId={viewerId} />
        <div className={styles.row} style={{ marginTop: 14 }}>
          {readyToggle}
          {advance('reveal')}
        </div>
      </>
    );
  } else if (setup.step === 'reveal') {
    const myInPlay = (state.players[viewerId]?.pokemon ?? []).flatMap((p) => p.stack);
    content = (
      <>
        <h2 className={styles.title}>いっせいにオモテにする</h2>
        <p className={styles.lead}>
          両者の準備ができたら、場に出したポケモンをオモテにして対戦開始です。
        </p>
        <div className={styles.row}>
          <button
            className={`${styles.button} ${styles.primary}`}
            disabled={myInPlay.length === 0}
            onClick={() => {
              for (const cardId of myInPlay) {
                dispatch({ type: 'setFaceUp', cardId, faceUp: true });
              }
              dispatch({ type: 'setCardVisibility', cardIds: myInPlay, visibleTo: players });
            }}
          >
            自分の場をオモテにする（{myInPlay.length}枚）
          </button>
        </div>
        <Seats state={state} viewerId={viewerId} />
        <div className={styles.row} style={{ marginTop: 14 }}>
          {readyToggle}
          <button
            className={`${styles.button} ${styles.primary}`}
            disabled={!bothReady}
            onClick={() => step('done')}
          >
            対戦を開始する
          </button>
        </div>
      </>
    );
  }

  if (collapsed) {
    return (
      <div className={styles.collapsedBar}>
        <span className={styles.collapsedStep}>対戦準備</span>
        <span>{SETUP_STEP_LABEL[setup.step]}</span>
        <span className={styles.footerNote}>
          {bothReady ? '両者の準備ができています' : '準備中'}
        </span>
        <button className={`${styles.button} ${styles.primary}`} onClick={() => setCollapsed(false)}>
          案内にもどる
        </button>
      </div>
    );
  }

  return (
    <div className={styles.backdrop}>
      <div className={styles.panel}>
        <div className={styles.steps}>
          {STEP_ORDER.map((s, i) => (
            <span
              key={s}
              className={`${styles.step} ${
                s === setup.step ? styles.stepCurrent : i < currentIndex ? styles.stepDone : ''
              }`}
            >
              <span className={styles.stepMark}>{i < currentIndex ? '✓' : `${i + 1}`}</span>
              {SETUP_STEP_LABEL[s]}
            </span>
          ))}
        </div>

        <div className={styles.body}>{content}</div>

        <div className={styles.footer}>
          <span className={styles.footerNote}>
            アプリはルールを判定しません。順番どおりか迷ったら、口頭で確認してください。
          </span>
          <button className={styles.button} onClick={() => setCollapsed(true)}>
            盤面を操作する
          </button>
          <button
            className={styles.button}
            disabled={currentIndex <= 0}
            onClick={() => step(STEP_ORDER[currentIndex - 1] ?? 'janken')}
          >
            前の段へ
          </button>
          <button className={styles.button} onClick={() => step('done')}>
            準備を飛ばして開始
          </button>
        </div>
      </div>
    </div>
  );
}
