#!/usr/bin/env node
/* ------------------------------------------------------------------ *
 * Atlas Kit MCP server — stdio entry (local Claude Code; see .mcp.json).
 *
 * Tools live in tools.mjs (transport-agnostic); this just connects the
 * server over stdio. The HTTP entry (remote connector) is http.mjs.
 *
 * Run: node --env-file=../../.env api/src/mcp/server.mjs
 * NOTE (stdio): never write to stdout except MCP protocol — log to stderr.
 * ------------------------------------------------------------------ */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { buildServer } from './tools.mjs'

const server = buildServer()
const transport = new StdioServerTransport()
await server.connect(transport)
console.error('[atlas-kit-mcp] stdio ready')
