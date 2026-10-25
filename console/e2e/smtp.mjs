// A minimal SMTP client for the end-to-end run: one message, plain text, no TLS.
import net from "node:net";

export function sendMail({ host, port, from, to, data }) {
  const commands = [
    "EHLO e2e.example.com",
    `MAIL FROM:<${from}>`,
    `RCPT TO:<${to}>`,
    "DATA",
    `${data.replace(/\r?\n/g, "\r\n").replace(/^\./gm, "..")}\r\n.`,
    "QUIT",
  ];
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    let buffer = "";
    let step = -1;
    let refused = null;
    socket.setTimeout(30000, () => socket.destroy(new Error("SMTP timed out")));
    socket.on("error", reject);
    socket.on("close", () => resolve(refused ? { accepted: false, reply: refused } : { accepted: true }));
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let end;
      while ((end = buffer.indexOf("\r\n")) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (!/^\d{3} /.test(line)) continue;
        const code = Number(line.slice(0, 3));
        if (code >= 400 && !refused) {
          refused = line;
          step = commands.length - 2;
        }
        step += 1;
        if (step < commands.length) socket.write(`${commands[step]}\r\n`);
      }
    });
  });
}
