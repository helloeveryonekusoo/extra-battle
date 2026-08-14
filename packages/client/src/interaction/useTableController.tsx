/**
 * 盤面の操作をまとめる層。
 * メニューを開く / 入力を受け取る / コマンドを送る、の3つだけを持つ。
 */
import { useCallback, useMemo, useState, type ReactNode } from 'react';
import type { ActionRequest, CardIndex, GameState, Intent, PlayerId } from '@pokeca/shared';
import { ContextMenu, type MenuPosition } from './ContextMenu';
import { PromptDialog } from './PromptDialog';
import { buildMenu, type MenuCommand, type MenuTarget, type PromptSpec } from './menus';

/** 実際に送る先。サーバー接続版とローカルデモ版がこれを満たす */
export interface Dispatcher {
  dispatch: (action: ActionRequest) => void;
  intent: (intent: Intent) => void;
  /** 乱数を伴う操作を頼めるか（§4.2） */
  canRandomize: boolean;
}

export interface TableController {
  /** 右クリック / 長押しでメニューを開く */
  openMenu: (target: MenuTarget, position: MenuPosition) => void;
  dispatch: (action: ActionRequest) => void;
  intent: (intent: Intent) => void;
  canRandomize: boolean;
  /** メニューとダイアログの描画。盤面の一番外側に置く */
  overlay: ReactNode;
}

/** 長押し（タッチ）でメニューを開くためのしきい値 */
const LONG_PRESS_MS = 480;

export function useLongPress(onLongPress: (position: MenuPosition) => void) {
  const timer = useState<{ id: ReturnType<typeof setTimeout> | null }>(() => ({ id: null }))[0];

  const start = useCallback(
    (e: React.PointerEvent) => {
      if (e.pointerType === 'mouse') return;
      const { clientX: x, clientY: y } = e;
      timer.id = setTimeout(() => onLongPress({ x, y }), LONG_PRESS_MS);
    },
    [onLongPress, timer],
  );

  const cancel = useCallback(() => {
    if (timer.id) clearTimeout(timer.id);
    timer.id = null;
  }, [timer]);

  return { onPointerDown: start, onPointerUp: cancel, onPointerLeave: cancel, onPointerCancel: cancel };
}

export function useTableController({
  state,
  cardIndex,
  viewerId,
  dispatcher,
}: {
  state: GameState;
  cardIndex: CardIndex | null;
  viewerId: PlayerId;
  dispatcher: Dispatcher;
}): TableController {
  const [menu, setMenu] = useState<{ target: MenuTarget; position: MenuPosition } | null>(null);
  const [prompt, setPrompt] = useState<PromptSpec | null>(null);

  const run = useCallback(
    (command: MenuCommand) => {
      if (command.kind === 'action') dispatcher.dispatch(command.action);
      else if (command.kind === 'intent') dispatcher.intent(command.intent);
      else setPrompt(command.prompt);
    },
    [dispatcher],
  );

  const openMenu = useCallback((target: MenuTarget, position: MenuPosition) => {
    setMenu({ target, position });
  }, []);

  const built = useMemo(
    () =>
      menu
        ? buildMenu(
            { state, cardIndex, viewerId, canRandomize: dispatcher.canRandomize },
            menu.target,
          )
        : null,
    [menu, state, cardIndex, viewerId, dispatcher.canRandomize],
  );

  const overlay = (
    <>
      {menu && built && (
        <ContextMenu
          title={built.title}
          items={built.items}
          position={menu.position}
          onPick={run}
          onClose={() => setMenu(null)}
        />
      )}
      {prompt && (
        <PromptDialog
          spec={prompt}
          state={state}
          cardIndex={cardIndex}
          onCancel={() => setPrompt(null)}
          onSubmit={(result) => {
            if ('action' in result) dispatcher.dispatch(result.action);
            else dispatcher.intent(result.intent);
            setPrompt(null);
          }}
        />
      )}
    </>
  );

  return {
    openMenu,
    dispatch: dispatcher.dispatch,
    intent: dispatcher.intent,
    canRandomize: dispatcher.canRandomize,
    overlay,
  };
}
