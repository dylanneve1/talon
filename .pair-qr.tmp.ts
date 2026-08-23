/**
 * Foreground WhatsApp QR pairing against ~/.talon/whatsapp-auth.
 * Run with the daemon STOPPED (it would fight for the auth dir).
 * Prints the QR in this terminal; exits 0 once the session is open
 * and creds are flushed.
 */
import { rmSync } from "node:fs";
import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
} from "baileys";
import qrcode from "qrcode-terminal";
import pino from "pino";

const AUTH_DIR = `${process.env.HOME}/.talon/whatsapp-auth`;
// Fresh start: any half-paired keypair from the loop would 401 instantly.
rmSync(AUTH_DIR, { recursive: true, force: true });

const logger = pino({ level: "silent" });

async function connect(): Promise<void> {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const sock = makeWASocket({
    auth: state,
    logger: logger as never,
    markOnlineOnConnect: false,
    qrTimeout: 120_000,
  });
  sock.ev.on("creds.update", saveCreds);
  await new Promise<void>((resolve, reject) => {
    sock.ev.on("connection.update", ({ connection, lastDisconnect, qr }) => {
      if (qr) {
        console.log("\n=== Scan with the BOT phone: WhatsApp -> Linked devices -> Link a device ===\n");
        qrcode.generate(qr, { small: true });
      }
      if (connection === "open") {
        console.log(`\nPAIRED as ${sock.user?.id ?? "?"} (${sock.user?.name ?? "no name"})`);
        // Give the key-store writes a moment to land, then close cleanly.
        setTimeout(() => {
          try { sock.end(undefined); } catch { /* closed */ }
          resolve();
        }, 3000);
      }
      if (connection === "close") {
        const code = (lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)
          ?.output?.statusCode;
        if (code === DisconnectReason.restartRequired) {
          // 515: pairing ACCEPTED — reconnect with the same creds to finish.
          console.log("Pairing accepted (515) — completing login...");
          resolve(connect());
          return;
        }
        if (!state.creds.registered && (code === 408 || code === 428)) {
          // QR cycle exhausted with no scan — serve a fresh one.
          console.log(`\n(QR expired — new one coming...)\n`);
          resolve(connect());
          return;
        }
        reject(new Error(`connection closed (code ${code ?? "?"})`));
      }
    });
  });
}

try {
  await connect();
  console.log("DONE — credentials saved. Restart the daemon.");
  process.exit(0);
} catch (err) {
  console.error("FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
}
