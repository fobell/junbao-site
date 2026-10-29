import http from "node:http";
import net from "node:net";
import { allowedHost, resolvePublic } from "../server/network.js";
const server = http.createServer((_req, res) => {
  res.writeHead(403);
  res.end("HTTPS required");
});
server.on("connect", async (req, client, head) => {
  try {
    const target = new URL(`https://${req.url}`);
    if (
      (target.port && target.port !== "443") ||
      !allowedHost(target.hostname, "browser")
    )
      throw new Error("Destination denied");
    const address = await resolvePublic(target.hostname);
    const upstream = net.connect(
      { host: address.address, port: 443, family: address.family },
      () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) upstream.write(head);
        upstream.pipe(client);
        client.pipe(upstream);
      },
    );
    upstream.setTimeout(120000, () => upstream.destroy());
    upstream.on("error", () => client.destroy());
    client.on("error", () => upstream.destroy());
    client.on("close", () => upstream.destroy());
  } catch {
    client.end("HTTP/1.1 403 Forbidden\r\n\r\n");
  }
});
server.listen(3128, "0.0.0.0");
