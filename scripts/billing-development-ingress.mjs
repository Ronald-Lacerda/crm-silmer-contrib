import http from 'node:http';
import net from 'node:net';

// Only this ingress has a published loopback socket. Targets are literals;
// neither request path, Host, environment nor query can select an external host.
for (const port of [4180, 5685]) {
  const server = http.createServer((request, response) => {
    const pathname = String(request.url ?? '/');
    if (!pathname.startsWith('/') || pathname.startsWith('//')) {
      response.writeHead(400).end();
      return;
    }
    const tools = pathname.startsWith('/__billing-development');
    const hostname = port === 5685 ? 'n8n' : 'billing-crm';
    const targetPort = port === 5685 ? 5678 : tools ? 3000 : 4173;
    const upstream = http.request(
      {
        hostname,
        port: targetPort,
        path: pathname,
        method: request.method,
        headers: { ...request.headers, host: `${hostname}:${targetPort}` },
      },
      (incoming) => {
        response.writeHead(incoming.statusCode ?? 502, incoming.headers);
        incoming.pipe(response);
      },
    );
    upstream.on('error', () => {
      if (!response.headersSent) response.writeHead(502);
      response.end('Local billing development service is starting.');
    });
    request.once('aborted', () => upstream.destroy());
    response.once('close', () => {
      if (!response.writableEnded) upstream.destroy();
    });
    request.pipe(upstream);
  });
  if (port === 5685)
    server.on('upgrade', (request, socket, head) => {
      if (
        !String(request.url ?? '').startsWith('/') ||
        String(request.url).startsWith('//')
      ) {
        socket.destroy();
        return;
      }
      const upstream = net.connect(5678, 'n8n', () => {
        const headers = {
          ...request.headers,
          host: 'n8n:5678',
          'x-forwarded-host': request.headers.host,
          'x-forwarded-proto': 'http',
        };
        upstream.write(
          `${request.method} ${request.url} HTTP/1.1\r\n` +
            Object.entries(headers)
              .filter(([, value]) => value !== undefined)
              .map(([name, value]) => `${name}: ${value}`)
              .join('\r\n') +
            '\r\n\r\n',
        );
        if (head.length) upstream.write(head);
        socket.pipe(upstream);
        upstream.pipe(socket);
      });
      upstream.once('error', () => socket.destroy());
      socket.once('error', () => upstream.destroy());
      socket.once('close', () => upstream.destroy());
    });
  server.listen(port, '0.0.0.0');
  for (const signal of ['SIGTERM', 'SIGINT'])
    process.once(signal, () => server.close());
}
