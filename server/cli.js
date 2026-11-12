#!/usr/bin/env node
import http from 'node:http';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { openDb } from './db.js';
import { authorize, createReceiver } from './http.js';
import { buildMcpServer } from './mcp.js';

// stdout is the MCP channel in local mode: log to stderr only.
const log = (msg) => process.stderr.write(`saveback: ${msg}\n`);
const env = process.env;
const remote = env.SAVEBACK_MODE === 'remote';

const token = env.SAVEBACK_TOKEN;
if (remote && !token) {
  log('SAVEBACK_TOKEN is required (and must not be empty) when SAVEBACK_MODE=remote');
  process.exit(1);
}

const dbPath = env.SAVEBACK_DB || join(homedir(), '.saveback', 'saveback.db');
mkdirSync(dirname(dbPath), { recursive: true });
const db = openDb(dbPath);
const receiver = createReceiver({ db, token: remote ? token : undefined });

if (remote) {
  // Stateless streamable HTTP: a fresh MCP server and transport per request, shared db handle.
  const handler = async (req, res) => {
    if ((req.url ?? '').split('?')[0] !== '/mcp') return receiver(req, res);
    if (!authorize(req, res, { token })) return;
    const mcp = buildMcpServer({ db });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => { transport.close(); mcp.close(); });
    try {
      await mcp.connect(transport);
      await transport.handleRequest(req, res);
    } catch (e) {
      log(`/mcp error: ${e instanceof Error ? e.message : e}`);
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' }).end('{"error":"internal error"}');
    }
  };
  const port = Number(env.PORT) || 8080;
  http.createServer(handler).listen(port, '0.0.0.0', () => log(`remote mode on 0.0.0.0:${port}`));
} else {
  const port = Number(env.SAVEBACK_PORT) || 7777;
  const server = http.createServer(receiver);
  server.on('error', (e) => {
    if (e.code !== 'EADDRINUSE') throw e;
    // Another Claude session already runs saveback; serve stdio MCP only (same SQLite file).
    log(`port ${port} already in use, skipping the receiver and serving MCP over stdio only`);
  });
  server.listen(port, '127.0.0.1', () => log(`receiver on 127.0.0.1:${port}`));

  await buildMcpServer({ db }).connect(new StdioServerTransport());
  // The http server would keep the process alive after the client hangs up.
  process.stdin.on('end', () => process.exit(0));
}
