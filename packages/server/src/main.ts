/**
 * サーバーの起動エントリ。
 *
 * 前提: Tailscale などのプライベートネットワーク上でのみ動かす（§2-7）。
 * 認証は簡易なルームコード方式。公開インターネットへの露出を前提にしない。
 */
import { DEFAULT_SERVER_PORT, PROTOCOL_VERSION } from '@pokeca/shared';
import { startServer } from './server';

const PORT = Number(process.env['PORT'] ?? DEFAULT_SERVER_PORT);
const HOST = process.env['HOST'] ?? '0.0.0.0';

const { wss } = startServer(PORT, HOST);

wss.on('listening', () => {
  console.log(`[server] ws://${HOST}:${PORT} で待機中 (protocol v${PROTOCOL_VERSION})`);
});
